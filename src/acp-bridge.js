import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { isLocalHostHeader, isLocalOrigin } from './local-host.js'

const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const CHILD_EXIT_GRACE_MS = 5000

// OMP's startup update check is the one telemetry surface that phones home by
// default (`startup.checkUpdate`, on unless configured off). Baize runs OMP
// with this overlay so the check is off regardless of the user's global OMP
// settings, and scrubs OTEL_* so OTLP export can never silently turn on.
const TELEMETRY_OPT_OUT_YML = 'startup:\n  checkUpdate: false\n'

function sanitizedChildEnv(env) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (key.startsWith('OTEL_')) delete clean[key]
  }
  return clean
}

function parseCommand(raw) {
  const command = raw.trim()
  if (!command) throw new Error('agent command is empty')
  const [cmd, ...args] = command.split(/\s+/)
  return { cmd, args }
}

function isJsonLine(text) {
  if (!text.startsWith('{')) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function killChild(child, logger) {
  if (child.exitCode !== null) return
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  }, CHILD_EXIT_GRACE_MS)
  force.unref()
  child.once('exit', () => clearTimeout(force))
  child.kill('SIGTERM')
  logger?.info('acp-bridge: sent SIGTERM to agent child')
}

// One WebSocket connection = one agent child process, dumb-piped per Panda's
// stdio↔WebSocket bridge contract (docs/acp-stdio-to-websocket.md upstream):
// frames become stdin lines, stdout lines become frames (never byte-passthrough
// — one TCP read can straddle a message boundary), non-JSON stdout lines are
// dropped+logged, and either side dying tears down the other.
//
// Two baize-owned injections ride on that pipe (#10):
// - `prepareWorkspace` (optional) runs before each spawn to lay out the
//   agent's project dir (fleet listing). It must never reject — a broken
//   workspace degrades the agent, it must not kill the chat.
// - `agentMcpServers` (optional) supplies ACP mcpServer descriptors that are
//   merged into session/new|load|resume requests. OMP's ACP mode does not
//   load project .omp/mcp.json (verified live against 18.1.15), so the ACP
//   wire channel is how baize hands the code index to the agent. A server
//   the client itself declared always wins by name.
const SESSION_METHODS_WITH_MCP = new Set(['session/new', 'session/load', 'session/resume'])

function injectMcpServers(raw, agentMcpServers, logger) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!msg || typeof msg.method !== 'string' || !SESSION_METHODS_WITH_MCP.has(msg.method)) return raw
  let servers = agentMcpServers()
  if (!Array.isArray(servers) || servers.length === 0) return raw
  const declared = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : []
  const declaredNames = new Set(declared.map((s) => s?.name))
  servers = servers.filter((s) => !declaredNames.has(s.name))
  if (servers.length === 0) return raw
  const out = { ...msg, params: { ...msg.params, mcpServers: [...declared, ...servers] } }
  logger?.info(`acp-bridge: injected MCP servers into ${msg.method}: ${servers.map((s) => s.name).join(', ')}`)
  return JSON.stringify(out)
}

export function createAcpBridge({ server, home, agentCommand = 'omp', logger, prepareWorkspace, agentMcpServers }) {
  const children = new Set()
  const overlayPath = join(home, 'omp-overlay.yml')
  const agentCwd = join(home, 'agent')
  let overlayWritten = false

  function agentArgs() {
    const { cmd, args } = parseCommand(agentCommand)
    // First write wins; a user-edited overlay is respected thereafter.
    if (!overlayWritten && !existsSync(overlayPath)) {
      writeFileSync(overlayPath, TELEMETRY_OPT_OUT_YML)
      overlayWritten = true
    }
    mkdirSync(agentCwd, { recursive: true })
    if (basename(cmd) === 'omp') {
      // Hidden upstream mode: `--mode=acp` speaks ACP JSON-RPC on stdio.
      // Exact basename match — a wrapper or a command merely ending in "omp"
      // must not silently receive OMP-specific flags.
      return { cmd, args: [...args, '--mode=acp', '--config', overlayPath], cwd: agentCwd }
    }
    return { cmd, args, cwd: agentCwd }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })

  server.on('upgrade', (req, socket, head) => {
    const path = req.url.split('?')[0]
    // The agent child is arbitrary command execution on this machine — the
    // upgrade gets the same guards as the API: local Host (DNS-rebinding
    // shield) and, when a browser sends Origin, a local Origin.
    if (
      path !== '/acp' ||
      !isLocalHostHeader(req.headers.host) ||
      !isLocalOrigin(req.headers.origin)
    ) {
      socket.destroy()
      return
    }
    // No subprotocol is required or requested — Panda connects with an empty
    // one and the browser aborts the handshake if the server demands one.
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', async (socket) => {
    if (prepareWorkspace) {
      try {
        prepareWorkspace()
      } catch (err) {
        logger?.warn(`acp-bridge: agent workspace preparation failed (agent starts degraded): ${err?.message ?? err}`)
      }
    }
    let child
    try {
      const { cmd, args, cwd } = agentArgs()
      child = spawn(cmd, args, {
        cwd,
        env: sanitizedChildEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      logger?.error(`acp-bridge: cannot spawn agent: ${err.message}`)
      socket.close(1011, 'agent spawn failed')
      return
    }
    children.add(child)
    logger?.info(`acp-bridge: agent child ${child.pid ?? 'not started'} (${agentCommand})`)

    socket.on('error', (err) => logger?.warn(`acp-bridge: socket error: ${err.message}`))
    // EPIPE after child death must not crash the process (bridge contract §3).
    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') logger?.warn(`acp-bridge: stdin error: ${err.message}`)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // stderr is not a protocol channel — surface it for observability,
      // bounded so a chatty agent cannot flood baize.log.
      for (const line of chunk.split('\n')) {
        if (line.trim()) logger?.info(`agent: ${line.slice(0, 2000)}`)
      }
    })

    socket.on('message', (data, isBinary) => {
      if (!isBinary && child.stdin && !child.stdin.destroyed) {
        let line = data.toString('utf8')
        if (agentMcpServers) {
          try {
            line = injectMcpServers(line, agentMcpServers, logger)
          } catch (err) {
            logger?.warn(`acp-bridge: MCP injection skipped (${err?.message ?? err}) — forwarding verbatim`)
          }
        }
        child.stdin.write(`${line}\n`)
      }
    })

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const json = isJsonLine(line)
        if (json && socket.readyState === socket.OPEN) {
          socket.send(line)
        } else if (!json) {
          logger?.warn(`acp-bridge: dropped non-JSON agent stdout line: ${line.slice(0, 200)}`)
        }
      }
    })

    socket.once('close', () => {
      logger?.info('acp-bridge: websocket closed; stopping agent child')
      killChild(child, logger)
    })

    child.once('exit', (code) => {
      children.delete(child)
      logger?.info(`acp-bridge: agent child exited (code ${code})`)
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(code === 0 ? 1000 : 1011, `agent exited (${code})`)
      }
    })

    child.once('error', (err) => {
      // ENOENT (agent not installed) lands here; the remedy must reach the log.
      children.delete(child)
      logger?.error(`acp-bridge: agent process error: ${err.message}`)
      if (socket.readyState === socket.OPEN) socket.close(1011, `agent failed to start: ${err.message}`)
    })
  })

  return {
    wss,
    activeChildren: () => children.size,
    async stop() {
      for (const child of [...children]) killChild(child, logger)
      await new Promise((resolve) => {
        const done = () => resolve()
        if (children.size === 0) return done()
        const timer = setTimeout(() => {
          for (const child of [...children]) child.kill('SIGKILL')
          done()
        }, CHILD_EXIT_GRACE_MS + 1000)
        const check = () => {
          if (children.size === 0) {
            clearTimeout(timer)
            done()
          } else {
            setTimeout(check, 100)
          }
        }
        check()
      })
      wss.close()
    },
  }
}
