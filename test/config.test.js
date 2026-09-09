import assert from 'node:assert/strict'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { configPath, DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { cleanupHome, tempHome } from './helpers.js'

test('first load creates config.json with defaults and mode 0600', () => {
  const home = tempHome()
  try {
    const config = loadConfig(home)
    assert.deepEqual(config, DEFAULT_CONFIG)
    assert.equal(statSync(configPath(home)).mode & 0o777, 0o600)
  } finally {
    cleanupHome(home)
  }
})

test('existing user values survive a reload', () => {
  const home = tempHome()
  try {
    loadConfig(home)
    const file = configPath(home)
    const edited = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    edited.port = 4321
    edited.pollIntervalMinutes = 60
    writeFileSync(file, JSON.stringify(edited))

    const config = loadConfig(home)
    assert.equal(config.port, 4321)
    assert.equal(config.pollIntervalMinutes, 60)
  } finally {
    cleanupHome(home)
  }
})

test('an older config gains new default keys without losing its own', () => {
  const home = tempHome()
  try {
    writeFileSync(configPath(home), JSON.stringify({ port: 8080 }))
    const config = loadConfig(home)
    assert.equal(config.port, 8080)
    assert.equal(config.pollIntervalMinutes, DEFAULT_CONFIG.pollIntervalMinutes)
  } finally {
    cleanupHome(home)
  }
})

test('a hand-created 0644 config is tightened to 0600', () => {
  const home = tempHome()
  try {
    const file = configPath(home)
    writeFileSync(file, JSON.stringify({ port: 1 }), { mode: 0o644 })
    loadConfig(home)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    cleanupHome(home)
  }
})

test('malformed config fails fast, naming the file', () => {
  const home = tempHome()
  try {
    writeFileSync(configPath(home), '{ not json')
    assert.throws(() => loadConfig(home), /invalid config file .*: /)
  } finally {
    cleanupHome(home)
  }
})
