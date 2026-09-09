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
    {
      name: 'grp/svc', path: '/wt/grp-svc-1a2b3c4d', addedAt: '2026-01-01T00:00:00Z',
      mirror: true, status: 'error', error: 'index_repository: boom',
      lastIndexedRevision: 'a'.repeat(40), retryAt: 1788972045968,
      stats: { nodes: 1, edges: 1 },
    },
  ],
  add: () => ({ name: 'new', path: '/x/new' }),
}
const gitlab = {
  getSettings: () => ({ baseUrl: 'https://gitlab.test', hasToken: true, selection: null }),
  saveSettings: ({ baseUrl, token, selection }) => {
    if (!baseUrl) throw Object.assign(new Error('field "baseUrl" is required'), { statusCode: 400, code: 'GITLAB_BAD_REQUEST' })
    return { baseUrl, hasToken: Boolean(token), selection: selection ?? null }
  },
  verify: () => ({ username: 'luka' }),
  discover: async (input) => {
    if (input?.group === 'unauthorized') {
      throw Object.assign(new Error('GitLab rejected the token (401)'), { statusCode: 401, code: 'GITLAB_UNAUTHORIZED' })
    }
    return { repos: [{ name: 'grp/a', defaultBranch: 'main', webUrl: 'https://gitlab.test/grp/a', archived: false }] }
  },
}
const syncCalls = []
const sync = {
  states: () => ({ 'grp/a': { status: 'needs-auth', branch: 'release', error: 'denied' } }),
  pollIntervalMinutes: () => 15,
  syncNow: async (name) => (syncCalls.push(['syncNow', name]), { synced: 1 }),
  syncAll: async () => (syncCalls.push(['syncAll']), { synced: 2 }),
  setBranch: (name, branch) => {
    if (name === 'grp/unknown') throw Object.assign(new Error('unknown mirror: grp/unknown (sync first)'), { statusCode: 400 })
    return { name, branch }
  },
}

// Fake SPA dist for static-serving tests.
const distDir = join(home, 'ui-dist')
mkdirSync(join(distDir, 'assets'), { recursive: true })
writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>baize spa</title>')
writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("spa")')

const server = createBaizeServer({ logger, registry, gitlab, sync, uiDist: distDir })
const noDistServer = createBaizeServer({ logger, registry, gitlab, sync, uiDist: join(home, 'no-dist') })
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
  assert.equal(body.repos.length, 2)
  assert.equal(body.repos[0].name, 'svc')
  assert.equal(body.repos[0].stats.nodes, 6)
  // Fleet entries carry the indexing fields the UI table joins on.
  const mirror = body.repos[1]
  assert.equal(mirror.mirror, true)
  assert.equal(mirror.lastIndexedRevision, 'a'.repeat(40))
  assert.equal(mirror.retryAt, 1788972045968)
  assert.match(mirror.error, /boom/)
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
  for (const path of ['/api/repos', '/', '/fleet']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, headers: { Host: 'evil.example.com' } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403, `${path} with forged Host must 403`)
  }
})

test('HEAD is served like GET (health-checker compatibility)', async () => {
  const res = await fetch(new URL('/api/health', base), { method: 'HEAD' })
  assert.equal(res.status, 200)

  const page = await fetch(base, { method: 'HEAD' })
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
})

test('malformed percent-encoding is a 400, not a 500', async () => {
  const res = await fetch(new URL('/%FF%FE%25', base))
  assert.equal(res.status, 400)
})

test('GET /api/gitlab/settings reports connection state without the token', async () => {
  const res = await fetch(new URL('/api/gitlab/settings', base))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { baseUrl: 'https://gitlab.test', hasToken: true, selection: null })
  assert.ok(!('token' in body), 'token must never echo')
})

test('POST /api/gitlab/settings without baseUrl is a 400', async () => {
  const res = await fetch(new URL('/api/gitlab/settings', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

test('POST /api/gitlab/discover returns repos; a 401 carries its machine code for the UI prompt', async () => {
  const ok = await fetch(new URL('/api/gitlab/discover', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'grp' }),
  })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).repos[0].name, 'grp/a')

  const denied = await fetch(new URL('/api/gitlab/discover', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'unauthorized' }),
  })
  assert.equal(denied.status, 401)
  const body = await denied.json()
  assert.equal(body.code, 'GITLAB_UNAUTHORIZED')
  assert.match(body.error, /token/)
})

test('POST /api/gitlab/verify reports the authenticated user (JSON gate applies)', async () => {
  const bare = await fetch(new URL('/api/gitlab/verify', base), { method: 'POST' })
  assert.equal(bare.status, 415, 'verify requires application/json like the other writes')

  const res = await fetch(new URL('/api/gitlab/verify', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  assert.deepEqual(await res.json(), { username: 'luka' })
})

test('unknown /api paths and non-GET unknown paths get a JSON 404', async () => {
  const api = await fetch(new URL('/api/nope', base))
  assert.equal(api.status, 404)
  assert.match(api.headers.get('content-type'), /application\/json/)

  const post = await fetch(new URL('/nope', base), { method: 'POST' })
  assert.equal(post.status, 404)
  assert.match(post.headers.get('content-type'), /application\/json/)
})

test('GET /api/sync exposes states and the poll interval', async () => {
  const res = await fetch(new URL('/api/sync', base))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    states: { 'grp/a': { status: 'needs-auth', branch: 'release', error: 'denied' } },
    pollIntervalMinutes: 15,
  })
})

test('POST /api/sync routes to syncAll or a per-repo syncNow (JSON gate applies)', async () => {
  const bare = await fetch(new URL('/api/sync', base), { method: 'POST' })
  assert.equal(bare.status, 415, 'sync requires application/json like the other writes')

  const before = syncCalls.length
  const all = await fetch(new URL('/api/sync', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(all.status, 200)
  assert.deepEqual(await all.json(), { synced: 2 })

  const one = await fetch(new URL('/api/sync', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'grp/a' }),
  })
  assert.equal(one.status, 200)
  assert.deepEqual(await one.json(), { synced: 1 })
  assert.deepEqual(syncCalls.slice(before), [['syncAll'], ['syncNow', 'grp/a']])
})

test('POST /api/sync/branch trims, nulls empty overrides, and rejects unknown repos', async () => {
  const missing = await fetch(new URL('/api/sync/branch', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(missing.status, 400)
  assert.match((await missing.json()).error, /name/)

  const set = await fetch(new URL('/api/sync/branch', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'grp/a', branch: '  release  ' }),
  })
  assert.deepEqual(await set.json(), { name: 'grp/a', branch: 'release' })

  const clear = await fetch(new URL('/api/sync/branch', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'grp/a', branch: '   ' }),
  })
  assert.deepEqual(await clear.json(), { name: 'grp/a', branch: null })

  const unknown = await fetch(new URL('/api/sync/branch', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'grp/unknown', branch: 'main' }),
  })
  assert.equal(unknown.status, 400)
  assert.match((await unknown.json()).error, /unknown mirror/)
})

test('requests are trace-logged to baize.log', async () => {
  await fetch(base)
  const log = readFileSync(logger.file, 'utf8')
  assert.match(log, /GET \/ -> 200/)
  assert.match(log, /GET \/api\/health -> 200/)
})
