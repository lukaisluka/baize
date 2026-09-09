import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createSyncEngine } from '../src/sync.js'
import { cleanupHome, tempHome } from './helpers.js'

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function makeSourceRepo(dir, { extraBranch = false } = {}) {
  const repo = join(dir, 'src-repo')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' })
  writeFileSync(join(repo, 'file.txt'), 'one\n')
  execFileSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' })
  execFileSync('git', ['-C', repo, 'commit', '-m', 'one', '--no-gpg-sign'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  if (extraBranch) {
    execFileSync('git', ['-C', repo, 'branch', 'release'], { encoding: 'utf8' })
  }
  return repo
}

const commitIn = (repo, text) => {
  writeFileSync(join(repo, 'file.txt'), `${text}\n`)
  execFileSync('git', ['-C', repo, 'commit', '-am', text, '--no-gpg-sign'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  return git(repo, 'rev-parse', 'HEAD')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error('waitFor: condition not met within timeout')
}

describe('fleet sync against a local git source', () => {
  const work = mkdtempSync(join(tmpdir(), 'baize-sync-'))
  const home = tempHome()
  const source = makeSourceRepo(work, { extraBranch: true })
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  let config = { gitlab: { selection: { type: 'group', path: 'grp' } }, mirrors: {}, pollIntervalMinutes: 15 }
  const saved = []
  const gitlab = {
    discover: async (input) => input.group
      ? { repos: [{ name: 'grp/alpha', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' }] }
      : { repos: input.repos.map((name) => ({ name, sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' })) },
  }
  let engine

  before(() => {
    engine = createSyncEngine({ home, config, save: () => saved.push(JSON.parse(JSON.stringify(config))), gitlab, logger })
  })
  after(() => {
    engine.stop()
    rmSync(work, { recursive: true, force: true })
    cleanupHome(home)
  })

  test('clones a bare mirror and records the head revision', { timeout: 60000 }, async () => {
    const result = await engine.syncAll()
    assert.equal(result.synced, 1)
    const state = engine.states()['grp/alpha']
    assert.equal(state.status, 'idle')
    assert.match(state.lastRevision, /^[0-9a-f]{40}$/)
    assert.ok(existsSync(engine.mirrorPathOf('grp/alpha')), 'bare mirror exists under repos/')
    assert.match(engine.mirrorPathOf('grp/alpha'), /\.git$/, 'mirror is a bare .git dir')
  })

  test('fetch keeps the mirror current on later cycles', { timeout: 60000 }, async () => {
    const newHead = commitIn(source, 'two')
    await engine.syncAll()
    assert.equal(engine.states()['grp/alpha'].lastRevision, newHead)
  })

  test('branch override re-syncs immediately and persists to config', { timeout: 60000 }, async () => {
    const mainHead = git(source, 'rev-parse', 'main')
    const releaseHead = git(source, 'rev-parse', 'release')
    assert.notEqual(mainHead, releaseHead)
    assert.equal(engine.states()['grp/alpha'].lastRevision, mainHead)

    engine.setBranch('grp/alpha', 'release')
    assert.equal(config.mirrors['grp/alpha'].branch, 'release')
    assert.ok(saved.some((c) => c.mirrors?.['grp/alpha']?.branch === 'release'), 'override persisted via save()')
    // setBranch queues a targeted re-sync — no explicit syncAll needed for
    // the recorded revision to follow the new branch.
    await waitFor(() => engine.states()['grp/alpha'].lastRevision === releaseHead)

    engine.setBranch('grp/alpha', null)
    assert.equal(config.mirrors['grp/alpha'], undefined, 'cleared override leaves no empty mirror entry behind')
    await waitFor(() => engine.states()['grp/alpha'].lastRevision === mainHead)
  })
})

describe('auth failure handling', () => {
  const work = mkdtempSync(join(tmpdir(), 'baize-sync-auth-'))
  const home = tempHome()
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const config = { gitlab: { selection: { type: 'repos', repos: ['grp/locked'] } }, mirrors: {} }
  let server
  let port
  let engine
  let clock = 1_000_000

  before(async () => {
    // A git http remote that always demands (and rejects) credentials.
    server = createServer((req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('denied')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    const url = `http://127.0.0.1:${port}/locked.git`
    const gitlab = { discover: async () => ({ repos: [{ name: 'grp/locked', sshUrl: url, httpUrl: url, defaultBranch: 'main', webUrl: 'x' }] }) }
    engine = createSyncEngine({
      home, config, save: () => {}, gitlab, logger,
      now: () => clock,
    })
  })
  after(() => {
    engine.stop()
    server.close()
    rmSync(work, { recursive: true, force: true })
    cleanupHome(home)
  })

  test('a 401 clone marks the repo needs-auth with an error trail', { timeout: 60000 }, async () => {
    await engine.syncAll()
    const state = engine.states()['grp/locked']
    assert.equal(state.status, 'needs-auth')
    assert.ok(state.error.length > 0, 'remediation error surfaced')
    assert.ok(state.backoffUntil > clock, 'backoff scheduled')
  })

  test('exponential backoff suppresses retries on the poll cycle', { timeout: 60000 }, async () => {
    const result = await engine.pollCycle()
    assert.equal(result.synced, 0, 'backed-off repo is skipped by the poll cycle')
    // A manual "Sync now" is explicit user intent — it must not be swallowed
    // by the backoff window.
    const manual = await engine.syncAll()
    assert.equal(manual.synced, 1, 'manual sync overrides backoff')
    clock += 61 * 60 * 1000 // past the 60m schedule ceiling
    const again = await engine.pollCycle()
    assert.equal(again.synced, 1, 'retry fires once the backoff window passes')
    assert.equal(engine.states()['grp/locked'].status, 'needs-auth')
  })
})
