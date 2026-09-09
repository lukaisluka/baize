import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createLogger } from '../src/logger.js'
import { ensureDataLayout } from '../src/paths.js'
import { close, createBaizeServer, listen } from '../src/server.js'
import { cleanupHome, tempHome } from './helpers.js'

const home = tempHome()
const logger = createLogger(ensureDataLayout(home).logs)
const server = createBaizeServer({ logger })
const bound = await listen(server, { port: 0 })
const base = `http://${bound.host}:${bound.port}`
after(async () => {
  await close(server)
  cleanupHome(home)
})

test('binds 127.0.0.1 only, on a chosen free port', () => {
  assert.equal(bound.host, '127.0.0.1')
  assert.ok(bound.port > 0)
})

test('GET / serves the placeholder page', async () => {
  const res = await fetch(base)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const html = await res.text()
  assert.match(html, /BaiZe/)
})

test('GET /api/health reports ok', async () => {
  const res = await fetch(new URL('/api/health', base))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok' })
})

test('unknown paths get a JSON 404', async () => {
  const res = await fetch(new URL('/nope', base))
  assert.equal(res.status, 404)
  assert.match(res.headers.get('content-type'), /application\/json/)
})

test('requests are trace-logged to baize.log', async () => {
  await fetch(base)
  const log = readFileSync(logger.file, 'utf8')
  assert.match(log, /GET \/ -> 200/)
  assert.match(log, /GET \/api\/health -> 200/)
})
