import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureDataLayout, resolveHome } from '../src/paths.js'
import { cleanupHome, tempHome } from './helpers.js'

test('resolveHome defaults to ~/.baize', () => {
  assert.equal(resolveHome({}), join(homedir(), '.baize'))
})

test('resolveHome honors BAIZE_HOME override', () => {
  assert.equal(resolveHome({ BAIZE_HOME: '/tmp/elsewhere' }), '/tmp/elsewhere')
})

test('ensureDataLayout creates repos/, index/, logs/ and is idempotent', () => {
  const home = tempHome()
  try {
    const dirs = ensureDataLayout(home)
    for (const name of ['repos', 'index', 'logs']) {
      assert.ok(statSync(dirs[name]).isDirectory(), `${name}/ created`)
    }
    ensureDataLayout(home)
    assert.ok(existsSync(join(home, 'repos')), 'second run leaves layout intact')
  } finally {
    cleanupHome(home)
  }
})
