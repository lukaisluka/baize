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
const registry = {
  list: async () => [
    { name: 'svc', path: '/x/svc', status: 'ready', stats: { nodes: 6, edges: 9 } },
  ],
  add: async () => {},
}
const server = createBaizeServer({ logger, registry })
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

test('GET /api/repos lists registry state', async () => {
  const res = await fetch(new URL('/api/repos', base))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.repos.length, 1)
  assert.equal(body.repos[0].name, 'svc')
  assert.equal(body.repos[0].stats.nodes, 6)
})

test('POST /api/repos without a path is a 400', async () => {
  const res = await fetch(new URL('/api/repos', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /path/)
})

test('POST /api/repos with invalid JSON body is a 400', async () => {
  const res = await fetch(new URL('/api/repos', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{nope',
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /JSON/)
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
