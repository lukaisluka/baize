import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  add: () => ({ name: 'new', path: '/x/new' }),
}

// Fake SPA dist for static-serving tests.
const distDir = join(home, 'ui-dist')
mkdirSync(join(distDir, 'assets'), { recursive: true })
writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>baize spa</title>')
writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("spa")')

const server = createBaizeServer({ logger, registry, uiDist: distDir })
const noDistServer = createBaizeServer({ logger, registry, uiDist: join(home, 'no-dist') })
const bound = await listen(server, { port: 0 })
const noDistBound = await listen(noDistServer, { port: 0 })
const base = `http://${bound.host}:${bound.port}`
const noDistBase = `http://${noDistBound.host}:${noDistBound.port}`
after(async () => {
  await close(server)
  await close(noDistServer)
  rmSync(distDir, { recursive: true, force: true })
  cleanupHome(home)
})

test('binds 127.0.0.1 only, on a chosen free port', () => {
  assert.equal(bound.host, '127.0.0.1')
  assert.ok(bound.port > 0)
})

test('GET / serves the built SPA index', async () => {
  const res = await fetch(base)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(await res.text(), /baize spa/)
})

test('deep links fall back to the SPA index (client-side routing)', async () => {
  const res = await fetch(new URL('/session/abc', base))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /baize spa/)
})

test('SPA assets are served with correct content types', async () => {
  const res = await fetch(new URL('/assets/app.js', base))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/javascript/)
})

test('path traversal outside the dist dir is refused', async () => {
  const res = await fetch(new URL('/..%2f..%2fconfig.json', base))
  assert.equal(res.status, 403)
})

test('when the SPA is not built, / explains the remedy', async () => {
  const res = await fetch(noDistBase)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /npm run build:ui/)
})

test('GET /fleet serves the fleet status page', async () => {
  const res = await fetch(new URL('/fleet', base))
  assert.equal(res.status, 200)
  assert.match(await res.text(), /BaiZe/)
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

test('POST /api/repos with a valid path returns 201 with the repo entry', async () => {
  const res = await fetch(new URL('/api/repos', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/x/new' }),
  })
  assert.equal(res.status, 201)
  assert.deepEqual(await res.json(), { name: 'new', path: '/x/new' })
})

test('POST /api/repos without JSON content-type is a 415 (cross-site text/plain guard)', async () => {
  const res = await fetch(new URL('/api/repos', base), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ path: '/x/new' }),
  })
  assert.equal(res.status, 415)
})

test('API requests with a non-local Host header are rejected (DNS-rebinding guard)', async () => {
  // fetch (undici) forbids overriding Host, so speak raw HTTP for this one.
  const { port } = new URL(base)
  const status = await new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/repos', headers: { Host: 'evil.example.com' } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
})

test('unknown /api paths and non-GET unknown paths get a JSON 404', async () => {
  const api = await fetch(new URL('/api/nope', base))
  assert.equal(api.status, 404)
  assert.match(api.headers.get('content-type'), /application\/json/)

  const post = await fetch(new URL('/nope', base), { method: 'POST' })
  assert.equal(post.status, 404)
  assert.match(post.headers.get('content-type'), /application\/json/)
})

test('requests are trace-logged to baize.log', async () => {
  await fetch(base)
  const log = readFileSync(logger.file, 'utf8')
  assert.match(log, /GET \/ -> 200/)
  assert.match(log, /GET \/api\/health -> 200/)
})
