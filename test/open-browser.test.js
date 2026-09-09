import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { openBrowser } from '../src/open-browser.js'

function fakeSpawn() {
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const child = new EventEmitter()
    child.unref = () => {
      child.unrefed = true
    }
    return child
  }
  spawnImpl.calls = calls
  return spawnImpl
}

test('platform openers are detached, stdio-ignored, and unrefed', async () => {
  for (const [platform, expected] of [
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'cmd'],
  ]) {
    const spawnImpl = fakeSpawn()
    openBrowser('http://127.0.0.1:1/', { platform, spawnImpl })
    const [call] = spawnImpl.calls
    assert.equal(call.cmd, expected)
    assert.ok(
      platform !== 'win32' ? call.args[0] === 'http://127.0.0.1:1/' : call.args.includes('http://127.0.0.1:1/'),
      `${platform} opener receives the URL`,
    )
    assert.equal(call.opts.detached, true)
    assert.deepEqual(call.opts.stdio, 'ignore')
  }
})

test('opener failure is reported to the logger, not thrown', async () => {
  const warnings = []
  const spawnImpl = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    return child
  }
  openBrowser('http://127.0.0.1:1/', {
    platform: 'linux',
    spawnImpl,
    logger: { warn: (m) => warnings.push(m) },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(warnings.some((m) => m.includes('xdg-open')), 'warn names the opener')
})
