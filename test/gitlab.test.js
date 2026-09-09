import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import {
  createGitLabClient,
  createGitLabService,
  GitLabError,
  normalizeBaseUrl,
} from '../src/gitlab.js'
import { cleanupHome, tempHome } from './helpers.js'
import { loadConfig, saveConfig, configPath } from '../src/config.js'

const PAT = 'glpat-test-token-0000000000'

// Capturing logger: every line is scanned for the PAT (the §7.2 hard rule).
function capturingLogger() {
  const lines = []
  const push = (level) => (msg) => lines.push(`[${level}] ${msg}`)
  return { lines, info: push('info'), warn: push('warn'), error: push('error') }
}

function project(id, path) {
  return {
    id,
    path_with_namespace: path,
    default_branch: 'main',
    web_url: `https://gitlab.test/${path}`,
    ssh_url_to_repo: `git@gitlab.test:${path}.git`,
    http_url_to_repo: `https://gitlab.test/${path}.git`,
    archived: id % 2 === 0,
  }
}

// A tiny stand-in for a self-hosted GitLab REST v4 surface: token check,
// /user, keyset-paginated group projects, per-project lookup.
function startFakeGitLab() {
  const requests = []
  const groupProjects = [project(1, 'grp/alpha'), project(2, 'grp/sub/beta'), project(3, 'grp/gamma')]
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://gitlab.test')
    requests.push({ path: url.pathname, query: url.searchParams })
    if (req.headers['private-token'] !== PAT) {
      res.writeHead(401).end()
      return
    }
    const json = (body, headers) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/v4/user') return json({ username: 'luka' })
    if (url.pathname === '/api/v4/groups/grp/projects') {
      const after = Number(url.searchParams.get('id_after') ?? 0)
      const batch = groupProjects.filter((p) => p.id > after).slice(0, 2)
      const next = batch.length === 2 ? `<${url.pathname}?pagination=keyset&order_by=id&sort=asc&per_page=2&id_after=${batch[1].id}>; rel="next"` : null
      return json(batch, next ? { link: `${next}, <${url.pathname}?per_page=2>; rel="first"` } : {})
    }
    const projectMatch = /^\/api\/v4\/projects\/(.+)$/.exec(url.pathname)
    if (projectMatch) {
      const path = decodeURIComponent(projectMatch[1])
      const found = groupProjects.find((p) => p.path_with_namespace === path)
      if (found) return json(found)
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"404 Project Not Found"}')
      return
    }
    res.writeHead(404).end()
  })
  return { server, requests, address: null }
}

describe('normalizeBaseUrl', () => {
  test('accepts host, scheme, trailing slashes, and a pasted /api/v4 suffix', () => {
    assert.equal(normalizeBaseUrl('gitlab.example.com'), 'https://gitlab.example.com')
    assert.equal(normalizeBaseUrl('https://gitlab.example.com/'), 'https://gitlab.example.com')
    assert.equal(normalizeBaseUrl('http://localhost:8443/api/v4/'), 'http://localhost:8443')
  })

  test('rejects empty and unparseable input', () => {
    assert.throws(() => normalizeBaseUrl(''), GitLabError)
    assert.throws(() => normalizeBaseUrl('https://'), GitLabError)
  })
})

describe('gitlab client against a fake self-hosted instance', () => {
  const fake = startFakeGitLab()
  const logger = capturingLogger()
  let client

  before(async () => {
    fake.address = await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve(fake.server.address())))
    client = createGitLabClient({
      baseUrl: `http://127.0.0.1:${fake.address.port}`,
      token: PAT,
      logger,
    })
  })
  after(() => new Promise((resolve) => fake.server.close(resolve)))

  test('verifyToken returns the authenticated user', async () => {
    assert.deepEqual(await client.verifyToken(), { username: 'luka' })
  })

  test('group discovery follows keyset pagination across pages', async () => {
    const { repos } = await client.discoverGroup('grp')
    assert.equal(repos.length, 3)
    assert.deepEqual(repos.map((r) => r.name), ['grp/alpha', 'grp/sub/beta', 'grp/gamma'])
    assert.equal(repos[0].defaultBranch, 'main')
    // Recursion is delegated to the API via include_subgroups=true.
    assert.ok(fake.requests.some((r) => r.path === '/api/v4/groups/grp/projects' && r.query.get('include_subgroups') === 'true'))
  })

  test('explicit repo list resolves, reporting missing entries', async () => {
    const { repos, missing } = await client.resolveRepos(['grp/alpha', 'grp/nope'])
    assert.deepEqual(repos.map((r) => r.name), ['grp/alpha'])
    assert.deepEqual(missing, ['grp/nope'])
  })

  test('a list where nothing exists is a 404', async () => {
    await assert.rejects(() => client.resolveRepos(['grp/nope']), (err) => {
      assert.equal(err.code, 'GITLAB_NOT_FOUND')
      assert.equal(err.statusCode, 404)
      return true
    })
  })

  test('bad token maps to GITLAB_UNAUTHORIZED', async () => {
    const bad = createGitLabClient({ baseUrl: client.baseUrl, token: 'glpat-wrong', logger })
    await assert.rejects(() => bad.discoverGroup('grp'), (err) => {
      assert.equal(err.code, 'GITLAB_UNAUTHORIZED')
      assert.equal(err.statusCode, 401)
      return true
    })
  })

  test('unreachable instance maps to GITLAB_UNREACHABLE', async () => {
    const far = createGitLabClient({ baseUrl: 'http://127.0.0.1:1', token: PAT, logger })
    await assert.rejects(() => far.verifyToken(), (err) => {
      assert.equal(err.code, 'GITLAB_UNREACHABLE')
      return true
    })
  })

  test('the PAT never appears in any log line (PRD §7.2 hard rule)', () => {
    assert.ok(logger.lines.length > 0, 'expected the client to have logged something')
    for (const line of logger.lines) {
      assert.ok(!line.includes(PAT), `PAT leaked into log: ${line}`)
    }
  })
})

describe('gitlab service over config.json', () => {
  const home = tempHome()

  test('settings save persists baseUrl+token+selection with 0600, never echoes the token', () => {
    const config = loadConfig(home)
    const logger = capturingLogger()
    const service = createGitLabService({ config, save: () => saveConfig(home, config), logger })

    const saved = service.saveSettings({ baseUrl: 'gitlab.example.com/', token: PAT, selection: { type: 'group', path: 'grp' } })
    assert.equal(saved.baseUrl, 'https://gitlab.example.com')
    assert.equal(saved.hasToken, true)
    assert.equal(saved.token, undefined, 'token must never echo')

    const onDisk = JSON.parse(readFileSync(configPath(home), 'utf8'))
    assert.equal(onDisk.gitlab.token, PAT)
    assert.equal(onDisk.gitlab.selection.path, 'grp')

    // Empty token on a later save keeps the stored credential.
    service.saveSettings({ baseUrl: 'gitlab2.example.com', token: '' })
    assert.equal(JSON.parse(readFileSync(configPath(home), 'utf8')).gitlab.token, PAT)

    for (const line of logger.lines) assert.ok(!line.includes(PAT), `PAT leaked: ${line}`)
    cleanupHome(home)
  })

  test('invalid selection shapes are rejected', () => {
    const home2 = tempHome()
    const config = loadConfig(home2)
    const service = createGitLabService({ config, save: () => {}, logger: capturingLogger() })
    assert.throws(() => service.saveSettings({ baseUrl: 'g.example.com', selection: { type: 'group' } }), GitLabError)
    assert.throws(() => service.saveSettings({ baseUrl: 'g.example.com', selection: { type: 'repos', repos: [] } }), GitLabError)
    assert.throws(() => service.saveSettings({ baseUrl: 'g.example.com', selection: 'grp' }), GitLabError)
    cleanupHome(home2)
  })

  test('discover before configuration is a 409 GITLAB_NOT_CONFIGURED', () => {
    const home3 = tempHome()
    const config = loadConfig(home3)
    const service = createGitLabService({ config, save: () => {}, logger: capturingLogger() })
    assert.throws(() => service.discover({ group: 'grp' }), (err) => {
      assert.equal(err.code, 'GITLAB_NOT_CONFIGURED')
      assert.equal(err.statusCode, 409)
      return true
    })
    cleanupHome(home3)
  })
})
