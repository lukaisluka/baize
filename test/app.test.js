import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startApp } from '../src/app.js'
import { configPath } from '../src/config.js'
import { cleanupHome, tempHome } from './helpers.js'

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
