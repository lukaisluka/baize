import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'
import { createAcpBridge } from '../src/acp-bridge.js'
import { close, listen } from '../src/server.js'
import { cleanupHome, tempHome } from './helpers.js'

const FAKE_AGENT = new URL('./fixtures/fake-agent.mjs', import.meta.url).pathname

const home = tempHome()
const logger = { info: () => {}, warn: () => {}, error: () => {} }
const server = createServer((req, res) => {
  res.writeHead(404).end()
})
const bridge = createAcpBridge({
  server,
  home,
  agentCommand: `node ${FAKE_AGENT}`,
  logger,
})
const bound = await listen(server, { port: 0 })
const wsUrl = `ws://${bound.host}:${bound.port}/acp`

after(async () => {
  await bridge.stop()
  await close(server)
  cleanupHome(home)
})

function connect(url = wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function request(ws, method, params = {}, id = Math.floor(Math.random() * 1e6)) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        ws.off('message', onMessage)
        resolve(msg)
      }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    setTimeout(() => reject(new Error(`${method} timed out`)), 10000).unref()
  })
}

function closed(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}

test('initialize round-trips through the bridge', { timeout: 20000 }, async () => {
  const ws = await connect()
  try {
    const reply = await request(ws, 'initialize', { protocolVersion: 1 })
    assert.equal(reply.result.agentInfo.name, 'fake-agent')
  } finally {
    ws.close()
  }
})

test('OMP telemetry opt-out: overlay written, OTEL_* scrubbed from child env', { timeout: 20000 }, async () => {
  const overlay = readFileSync(join(home, 'omp-overlay.yml'), 'utf8')
  assert.match(overlay, /checkUpdate: false/)

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://leak.test'
  let ws
  try {
    ws = await connect()
    const reply = await request(ws, 'ping')
    assert.equal(reply.result.pong, true)
    assert.deepEqual(reply.result.otelLeaked, [], 'OTEL_* must not reach the agent child')
  } finally {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ws?.close()
  }
})

test('non-JSON agent stdout lines are dropped, not forwarded', { timeout: 20000 }, async () => {
  const ws = await connect()
  try {
    const reply = await request(ws, 'noise')
    assert.equal(reply.result.noisy, true, 'the real reply after the noise line still arrives')
  } finally {
    ws.close()
  }
})

test('client disconnect kills the agent child', { timeout: 20000 }, async () => {
  const ws = await connect()
  await request(ws, 'initialize')
  assert.equal(bridge.activeChildren(), 1)
  ws.close()
  await new Promise((resolve) => {
    const check = () => (bridge.activeChildren() === 0 ? resolve() : setTimeout(check, 100))
    check()
  })
})

test('agent exit closes the websocket (1011 for non-zero exit)', { timeout: 20000 }, async () => {
  const ws = await connect()
  const closeCode = closed(ws)
  await request(ws, 'die')
  assert.equal(await closeCode, 1011)
  assert.equal(bridge.activeChildren(), 0)
})

test('upgrade to a non-/acp path is destroyed', { timeout: 20000 }, async () => {
  await assert.rejects(
    () => connect(`ws://${bound.host}:${bound.port}/other`),
    (err) => {
      // ws client surfaces the server-side destroy as an unexpected close/error.
      assert.ok(err, 'expected the connection to fail')
      return true
    },
  )
})

// Raw handshake control: `ws` neither sends Origin nor lets us forge Host.
function upgradeRequest(headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: bound.host,
        port: bound.port,
        path: '/acp',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          ...headers,
        },
      },
      (res) => resolve({ status: res.statusCode }),
    )
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, upgraded: true, socket }))
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ destroyed: true }) : reject(err)))
    req.end()
    setTimeout(() => reject(new Error('upgrade probe timed out')), 5000).unref()
  })
}

test('upgrade with a forged Host is destroyed (DNS-rebinding guard)', { timeout: 20000 }, async () => {
  const outcome = await upgradeRequest({ host: 'evil.example.com' })
  assert.ok(!outcome.upgraded, `expected no upgrade, got ${JSON.stringify(outcome)}`)
})

test('upgrade with a non-local browser Origin is destroyed', { timeout: 20000 }, async () => {
  const outcome = await upgradeRequest({ origin: 'https://evil.example.com' })
  assert.ok(!outcome.upgraded, `expected no upgrade, got ${JSON.stringify(outcome)}`)
})

test('upgrade with a local browser Origin is accepted', { timeout: 20000 }, async () => {
  const outcome = await upgradeRequest({ origin: `http://localhost:${bound.port}` })
  assert.equal(outcome.status, 101)
  // The handshake spawned an agent child; drop the socket so it is reaped.
  outcome.socket.destroy()
  await new Promise((resolve) => {
    const check = () => (bridge.activeChildren() === 0 ? resolve() : setTimeout(check, 100))
    check()
  })
})

test('agent stdout split across TCP reads yields intact separate frames', { timeout: 20000 }, async () => {
  // Byte-passthrough bridges would splice these into broken frames; the
  // bridge must reassemble on newline boundaries (contract §1).
  const ws = await connect()
  try {
    const { reply, notification } = await new Promise((resolve, reject) => {
      let reply
      const id = 424242
      const timer = setTimeout(() => reject(new Error('split test timed out')), 10000)
      timer.unref()
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) reply = msg
        if (msg.method === 'split/notification') {
          clearTimeout(timer)
          resolve({ reply, notification: msg })
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'split', params: {} }))
    })
    assert.equal(reply.result.split, 1)
    assert.deepEqual(notification.params, { half: true })
  } finally {
    ws.close()
  }
})

// The #10 wiring: workspace preparation runs before each spawn, and a broken
// preparation degrades (logged) instead of killing the chat connection.
test('prepareWorkspace runs per connection and its failure does not block spawn', { timeout: 20000 }, async () => {
  let prepared = 0
  const out = { wired: true }
  const failHome = tempHome()
  const failServer = createServer((req, res) => res.writeHead(404).end())
  const failBridge = createAcpBridge({
    server: failServer,
    home: failHome,
    agentCommand: `node ${FAKE_AGENT}`,
    logger,
    prepareWorkspace: () => {
      prepared += 1
      if (prepared === 1) return out.wired // success path
      throw new Error('disk on fire')
    },
  })
  const failBound = await listen(failServer, { port: 0 })
  try {
    const first = await connect(`ws://${failBound.host}:${failBound.port}/acp`)
    const reply = await request(first, 'initialize')
    assert.equal(reply.result.agentInfo.name, 'fake-agent')
    first.close()
    await new Promise((resolve) => {
      const check = () => (failBridge.activeChildren() === 0 ? resolve() : setTimeout(check, 100))
      check()
    })

    const second = await connect(`ws://${failBound.host}:${failBound.port}/acp`)
    const secondReply = await request(second, 'initialize')
    assert.equal(secondReply.result.agentInfo.name, 'fake-agent', 'throwing prepare does not block the agent')
    second.close()
    assert.equal(prepared, 2, 'preparation ran once per connection')
  } finally {
    await failBridge.stop()
    await close(failServer)
    cleanupHome(failHome)
  }
})

// The #10 MCP wiring: baize's servers are injected into session/* requests on
// the wire (OMP's ACP mode ignores project .omp/mcp.json — this is the only
// channel), and anything the client itself declared wins by name.
test('agentMcpServers are injected into session/new; client-declared servers win', { timeout: 20000 }, async () => {
  const mcpHome = tempHome()
  const mcpServer = createServer((req, res) => res.writeHead(404).end())
  const mine = () => [
    { name: 'codebase-memory', command: '/cbm', args: ['--ui=false'], env: [{ name: 'CBM_CACHE_DIR', value: '/idx' }] },
    { name: 'extra', command: '/extra' },
  ]
  const mcpBridge = createAcpBridge({
    server: mcpServer,
    home: mcpHome,
    agentCommand: `node ${FAKE_AGENT}`,
    logger,
    agentMcpServers: mine,
  })
  const mcpBound = await listen(mcpServer, { port: 0 })
  try {
    const ws = await connect(`ws://${mcpBound.host}:${mcpBound.port}/acp`)
    const withOwn = await request(ws, 'session/new', {
      cwd: '/x',
      mcpServers: [{ name: 'codebase-memory', command: '/client-declared' }],
    })
    assert.deepEqual(
      withOwn.result.params.mcpServers,
      [
        { name: 'codebase-memory', command: '/client-declared' }, // client's wins
        { name: 'extra', command: '/extra' }, // baize's others still ride along
      ],
      'codebase-memory clash resolved to the client declaration',
    )

    const fresh = await request(ws, 'session/new', { cwd: '/x' })
    assert.deepEqual(fresh.result.params.mcpServers, mine(), 'without client servers both are injected')
    assert.equal(fresh.result.params.cwd, '/x', 'other params untouched')

    // load/resume take the same parameter — session restarts must not lose CBM.
    const loaded = await request(ws, 'session/load', { sessionId: 's-x', cwd: '/x' })
    assert.deepEqual(loaded.result.params.mcpServers, mine(), 'session/load is injected too')
    const resumed = await request(ws, 'session/resume', { sessionId: 's-x' })
    assert.deepEqual(resumed.result.params.mcpServers, mine(), 'session/resume is injected too')

    const nonSession = await request(ws, 'session/prompt', { prompt: [] })
    assert.equal(nonSession.result.params.mcpServers, undefined, 'non-session methods pass through untouched')

    // A non-JSON client frame survives the injection parser verbatim: it is
    // forwarded as-is (the agent drops it), and the connection stays up.
    ws.send('this is not json')
    const afterNoise = await request(ws, 'ping', {})
    assert.deepEqual(afterNoise.result, { pong: true, otelLeaked: [] }, 'non-JSON frame forwarded verbatim, connection healthy')
    ws.close()
  } finally {
    await mcpBridge.stop()
    await close(mcpServer)
    cleanupHome(mcpHome)
  }
})
