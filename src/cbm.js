import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

const PROTOCOL_VERSION = '2024-11-05'

// The npm package ships only a launcher; the static binary is downloaded by
// postinstall from GitHub Releases (needs network at install time). If it is
// absent — e.g. `npm install --ignore-scripts` and no lazy download yet —
// fail fast with the remedy instead of a confusing ENOENT at spawn time.
export function resolveCbmBinary() {
  let pkgDir
  try {
    pkgDir = dirname(require.resolve('codebase-memory-mcp/package.json'))
  } catch {
    throw new Error(
      'codebase-memory-mcp is not installed. Run: npm install (or npm rebuild codebase-memory-mcp)',
    )
  }
  const binName = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp'
  const binPath = join(pkgDir, 'bin', binName)
  if (!existsSync(binPath)) {
    throw new Error(
      `CBM binary missing at ${binPath}. ` +
        'The postinstall download was skipped or failed. Remedy (online): ' +
        'npx codebase-memory-mcp --version  — then restart baize; ' +
        'or npm rebuild codebase-memory-mcp; offline: pre-seed the binary at the path above.',
    )
  }
  return binPath
}

function toolErrorMessage(result, tool) {
  const structured = result?.structuredContent?.error
  if (structured) return `${tool}: ${structured}`
  const text = result?.content?.find((c) => c.type === 'text')?.text
  return `${tool}: ${text || 'unknown tool error'}`
}

// Owns the CBM child process lifecycle: MCP over stdio (newline-delimited
// JSON-RPC). CBM itself backs the server with a background daemon; SIGTERM on
// the stdio child tears it down, and a final `daemon stop` reaps any that
// lingered (a no-op when none is running). Lazy: nothing spawns until the
// first call, so `baize` with no repos indexed never pays the daemon boot.
export class CbmSupervisor {
  constructor({ binaryPath, cacheDir, logger, spawnImpl = spawn } = {}) {
    this.requestedBinaryPath = binaryPath
    this.cacheDir = cacheDir
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.child = null
    this.stopping = false
    this.nextId = 1
    this.pending = new Map() // jsonrpc id -> { resolve, reject, tool }
    this.ready = null // handshake promise
  }

  // Resolved lazily so constructing the supervisor never requires the binary —
  // baize must start fine on a machine where the postinstall download failed.
  #binaryPath() {
    return (this.binaryPath ??= this.requestedBinaryPath ?? resolveCbmBinary())
  }

  async ensure() {
    if (this.child && this.child.exitCode === null && this.ready) return this.ready
    this.stopping = false
    const child = this.spawnImpl(this.#binaryPath(), ['--ui=false'], {
      env: { ...process.env, CBM_CACHE_DIR: this.cacheDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) this.#onMessage(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // CBM logs diagnostics (memory budget, daemon hints) on stderr; keep
      // them in baize.log with a prefix so they are greppable.
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.logger?.info(`cbm: ${line}`)
      }
    })
    child.on('exit', (code, signal) => {
      // A replaced child (handshake failure → respawn) can exit late; its
      // exit must not clobber the state of the child that replaced it.
      if (child !== this.child) return
      this.#onExit(code, signal)
    })
    // Spawn failures (EACCES/ENOENT race/ENOEXEC) fire 'error', not 'exit' —
    // without this listener they would crash the whole baize process.
    child.on('error', (err) => {
      if (child !== this.child) return
      this.logger?.error(`cbm: spawn/stream error: ${err.message}`)
      this.#onExit(err.code ?? '?', null)
    })
    // EPIPE on a dying child must not crash the process; the exit handler owns cleanup.
    child.stdin.on('error', (err) => this.logger?.warn(`cbm: stdin error: ${err.message}`))

    this.everStarted = true
    this.logger?.info(`cbm: spawned ${this.#binaryPath()} (cache: ${this.cacheDir})`)
    this.ready = this.#handshake()
      .then(() => {
        // The child can die mid-handshake without a pending request noticing.
        if (child.exitCode !== null) {
          throw new Error('cbm: process exited during handshake')
        }
      })
      .catch((err) => {
        // A wedged-rejected ready would poison every future call (ensure()
        // early-returns it). Reset and kill the child so the next call
        // starts fresh instead of hanging forever.
        this.ready = null
        if (child.exitCode === null) child.kill('SIGTERM')
        throw err
      })
    return this.ready
  }

  async #handshake() {
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'baize', version: '0.0.1' },
    }, { timeoutMs: 30000 })
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.logger?.info(`cbm: connected (server ${result?.serverInfo?.name ?? '?'} ${result?.serverInfo?.version ?? '?'})`)
  }

  async call(tool, args = {}, { timeoutMs } = {}) {
    await this.ensure()
    return this.#request('tools/call', { name: tool, arguments: args }, { timeoutMs })
  }

  async stop() {
    this.stopping = true
    const child = this.child
    if (!this.everStarted) {
      // Never spawned anything: there is no daemon of ours to stop, and the
      // daemon-stop subprocess costs ~6s of its own startup — skip it.
      return
    }
    if (!child || child.exitCode !== null) {
      // Child already gone; still reap a possible leftover daemon.
      try {
        await this.#stopDaemon()
      } catch (err) {
        this.logger?.info(`cbm: daemon stop skipped (${err.message})`)
      }
      return
    }
    await new Promise((resolve) => {
      child.once('exit', resolve)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 5000).unref()
    })
    await this.#stopDaemon()
  }

  async #stopDaemon() {
    const result = spawnSync(this.#binaryPath(), ['daemon', 'stop'], {
      env: { ...process.env, CBM_CACHE_DIR: this.cacheDir },
      timeout: 15000,
      encoding: 'utf8',
    })
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    if (result.error || result.status !== 0) {
      // A daemon that refused to stop is exactly the orphan-daemon failure
      // mode #8 exists to prevent — log it loudly, not as routine INFO.
      this.logger?.warn(
        `cbm: daemon stop failed (status=${result.status ?? 'n/a'}${result.error ? ` error=${result.error.message}` : ''}): ${out}`,
      )
      return
    }
    this.logger?.info(`cbm: daemon stop -> ${out || 'ok'}`)
  }

  #send(message) {
    if (!this.child || this.child.exitCode !== null) {
      throw new Error('cbm: process exited before send')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #request(method, params, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const entry = { resolve, reject, tool: params?.name ?? method }
      this.pending.set(id, entry)
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${entry.tool}: timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        entry.timer.unref()
      }
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  #onMessage(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.logger?.warn(`cbm: unparseable stdout line: ${line.slice(0, 200)}`)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      entry.reject(new Error(`${entry.tool}: ${message.error.message ?? JSON.stringify(message.error)}`))
      return
    }
    const result = message.result
    if (result?.isError) {
      entry.reject(new Error(toolErrorMessage(result, entry.tool)))
      return
    }
    entry.resolve(result?.structuredContent ?? result ?? null)
  }

  #onExit(code, signal) {
    const error = new Error(`cbm: process exited (code ${code}, signal ${signal}) before responding`)
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
    this.ready = null
    if (!this.stopping) {
      // Unexpected crash: surface it; the next call lazily restarts the child.
      this.logger?.error(`cbm: unexpected exit (code ${code}, signal ${signal}); will restart on next use`)
    } else {
      this.logger?.info(`cbm: stopped (code ${code}, signal ${signal})`)
    }
  }
}
