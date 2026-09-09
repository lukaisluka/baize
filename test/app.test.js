import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { startApp } from '../src/app.js'
import { configPath } from '../src/config.js'
import { cleanupHome, tempHome } from './helpers.js'

const FAKE_AGENT = new URL('./fixtures/fake-agent.mjs', import.meta.url).pathname

test('startApp wires layout, config, server together and stop() closes it', async () => {
  const home = tempHome()
  const lines = []
  try {
    const app = await startApp({
      home,
      openBrowser: false,
      stdout: { write: (line) => lines.push(line) },
    })

    assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(lines.some((l) => l.includes(app.url)), 'URL printed to stdout')

    for (const name of ['repos', 'index', 'logs']) {
      assert.ok(existsSync(join(home, name)), `${name}/ exists`)
    }
    assert.ok(existsSync(configPath(home)), 'config.json exists')
    assert.equal(statSync(configPath(home)).mode & 0o777, 0o600)

    const res = await fetch(app.url)
    assert.equal(res.status, 200)

    await app.stop()
    await assert.rejects(() => fetch(app.url), /fetch failed/)
  } finally {
    cleanupHome(home)
  }
})

test('explicit port is honored (failure surfaces, e.g. EADDRINUSE)', async () => {
  const home = tempHome()
  const first = await startApp({ home, port: 0, openBrowser: false })
  try {
    await assert.rejects(
      () => startApp({ home, port: first.port, openBrowser: false }),
      (err) => {
        assert.equal(err.code, 'EADDRINUSE')
        return true
      },
    )
  } finally {
    await first.stop()
    cleanupHome(home)
  }
})

test('stop() completes promptly even with an open agent connection', { timeout: 20000 }, async () => {
  // Regression: server.close() waits for upgraded sockets, so stopping the
  // bridge (which closes them) must happen BEFORE closing the server.
  const home = tempHome()
  mkdirSync(home, { recursive: true })
  writeFileSync(
    configPath(home),
    JSON.stringify({ agentCommand: `node ${FAKE_AGENT}` }),
  )
  const app = await startApp({ home, port: 0, openBrowser: false })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/acp`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    await new Promise((resolve) => ws.once('message', resolve))
    assert.equal(app.bridge.activeChildren(), 1)

    const stopped = app.stop()
    // A hanging close(server) would blow the 20s test timeout; the fix keeps
    // the whole shutdown well under the child SIGTERM grace period.
    const finished = await Promise.race([
      stopped.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 12000)),
    ])
    assert.equal(finished, true, 'app.stop() resolved without the client disconnecting')
    assert.equal(app.bridge.activeChildren(), 0)
  } finally {
    cleanupHome(home)
  }
})
