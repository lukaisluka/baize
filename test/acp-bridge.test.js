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
