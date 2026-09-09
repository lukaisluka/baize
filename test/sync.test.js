import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createSyncEngine, isValidRemoteUrl } from '../src/sync.js'
import { cleanupHome, tempHome } from './helpers.js'

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}

function makeSourceRepo(dir, { extraBranch = false } = {}) {
  const repo = join(dir, 'src-repo')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf8' })
  writeFileSync(join(repo, 'file.txt'), 'one\n')
  execFileSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' })
  execFileSync('git', ['-C', repo, 'commit', '-m', 'one', '--no-gpg-sign'], { encoding: 'utf8', env: GIT_ENV })
  if (extraBranch) {
    execFileSync('git', ['-C', repo, 'branch', 'release'], { encoding: 'utf8' })
  }
  return repo
}

const commitIn = (repo, text) => {
  writeFileSync(join(repo, 'file.txt'), `${text}\n`)
  execFileSync('git', ['-C', repo, 'commit', '-am', text, '--no-gpg-sign'], {
    encoding: 'utf8',
    env: GIT_ENV,
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

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} }

describe('remote URL allowlist', () => {
  test('accepts the transports GitLab actually returns', () => {
    for (const url of [
      'https://gitlab.com/group/project.git',
      'http://127.0.0.1:8931/group/project.git',
      'ssh://git@gitlab.com:22/group/project.git',
      'git://gitlab.com/group/project.git',
      'git@gitlab.com:group/project.git',
    ]) {
      assert.equal(isValidRemoteUrl(url), true, url)
    }
  })

  test('rejects command-executing transports, local paths, and option injection', () => {
    for (const url of [
      'ext::sh -c id', // transport that executes a command (git < 2.48 allows by default)
      'fd::17',
      'file:///Users/x/.ssh', // local read into a mirror
      '/tmp/local/repo',
      '--upload-pack=evil', // option position injection
      '-Oproxy=http://evil',
      'https://host/repo.git extra-arg', // whitespace = argument smuggling
      'git@host:repo\nanother', // newline smuggling
      'git@hostnopath',
      '',
      null,
    ]) {
      assert.equal(isValidRemoteUrl(url), false, String(url))
    }
  })

  test('rejects control characters and dash-leading hostnames', () => {
    // A NUL byte makes spawn() throw synchronously — it must die at the door,
    // not depend on every caller catching the throw.
    assert.equal(isValidRemoteUrl('ssh://git@host/repo\0evil'), false)
    assert.equal(isValidRemoteUrl('https://host/\x01x'), false)
    // git blocks dash-leading hostnames itself; refuse them independently of
    // the installed git version.
    assert.equal(isValidRemoteUrl('ssh://-oProxyCommand=evil/x'), false)
  })

  test('engine refuses to clone rejected URLs and leaves no repos dir', { timeout: 60000 }, async () => {
    const home = tempHome()
    const config = { gitlab: { selection: { type: 'repos', repos: ['grp/evil', 'grp/flag', 'grp/plain'] } }, mirrors: {} }
    const gitlab = {
      discover: async () => ({
        repos: [
          { name: 'grp/evil', sshUrl: 'ext::sh -c id', httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
          { name: 'grp/flag', sshUrl: '--upload-pack=evil', httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
          { name: 'grp/plain', sshUrl: '/tmp/not-allowed-repo', httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
        ],
      }),
    }
    const engine = createSyncEngine({ home, config, save: () => {}, gitlab, logger: quietLogger })
    try {
      const result = await engine.syncAll()
      assert.equal(result.synced, 0, 'nothing synced')
      assert.equal(result.failed, 3, 'each rejection counted as a failure')
      const states = engine.states()
      for (const name of ['grp/evil', 'grp/flag', 'grp/plain']) {
        assert.equal(states[name].status, 'error', name)
        assert.match(states[name].error, /rejected remote URL/)
      }
      assert.ok(!existsSync(join(home, 'repos')), 'no clone was ever started')
    } finally {
      await engine.stop()
      cleanupHome(home)
    }
  })

  test('one repo with a spawn-breaking URL cannot stall the rest of the cycle', { timeout: 60000 }, async () => {
    const work = mkdtempSync(join(tmpdir(), 'baize-sync-hostile-'))
    const home = tempHome()
    const source = makeSourceRepo(work)
    const config = { gitlab: { selection: { type: 'repos', repos: ['g/bad', 'g/good'] } }, mirrors: {} }
    const gitlab = {
      discover: async () => ({
        repos: [
          // Deliberately permissive validator below: the allowlist normally
          // stops NUL bytes at the door (unit tests above) — this proves the
          // engine still survives one that slips through to spawn().
          { name: 'g/bad', sshUrl: 'ssh://git@host/repo\0evil', httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
          { name: 'g/good', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' },
        ],
      }),
    }
    const engine = createSyncEngine({ home, config, save: () => {}, gitlab, logger: quietLogger, validateUrl: () => true })
    try {
      const result = await engine.syncAll()
      assert.equal(result.synced, 1, 'the good repo still synced')
      assert.equal(result.failed, 1)
      assert.equal(engine.states()['g/bad'].status, 'error')
      assert.match(engine.states()['g/bad'].error, /failed to start git/)
      assert.equal(engine.states()['g/good'].status, 'idle')
    } finally {
      await engine.stop()
      rmSync(work, { recursive: true, force: true })
      cleanupHome(home)
    }
  })
})

describe('fleet sync against a local git source', () => {
  const work = mkdtempSync(join(tmpdir(), 'baize-sync-'))
  const home = tempHome()
  const source = makeSourceRepo(work, { extraBranch: true })
  // Local paths as remotes are a test convenience; production only ever sees
  // https/ssh URLs (isValidRemoteUrl is the default).
  const allowLocal = (url) => String(url).startsWith('/') || isValidRemoteUrl(url)
  let config = { gitlab: { selection: { type: 'group', path: 'grp' } }, mirrors: {}, pollIntervalMinutes: 15 }
  const saved = []
  const gitlab = {
    discover: async (input) => input.group
      ? { repos: [{ name: 'grp/alpha', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' }] }
      : { repos: input.repos.map((name) => ({ name, sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' })) },
  }
  let engine

  before(() => {
    engine = createSyncEngine({ home, config, save: () => saved.push(JSON.parse(JSON.stringify(config))), gitlab, logger: quietLogger, validateUrl: allowLocal })
  })
  after(async () => {
    await engine.stop()
    rmSync(work, { recursive: true, force: true })
    cleanupHome(home)
  })

  test('mirror paths cannot collide between distinct GitLab projects', () => {
    assert.notEqual(engine.mirrorPathOf('grp/alpha'), engine.mirrorPathOf('grp-alpha'))
  })

  test('clones a bare mirror and records the head revision', { timeout: 60000 }, async () => {
    const result = await engine.syncAll()
    assert.equal(result.synced, 1)
    const state = engine.states()['grp/alpha']
    assert.equal(state.status, 'idle')
    assert.match(state.lastRevision, /^[0-9a-f]{40,64}$/)
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

describe('mirror healing and config hygiene', () => {
  const work = mkdtempSync(join(tmpdir(), 'baize-sync-heal-'))
  const home = tempHome()
  const source = makeSourceRepo(work)
  const allowLocal = (url) => String(url).startsWith('/') || isValidRemoteUrl(url)
  const config = { gitlab: { selection: { type: 'repos', repos: ['grp/alpha', 'grp/gone'] } }, mirrors: { 'grp/gone': { branch: 'main' } } }
  const saved = []
  const reposList = [{ name: 'grp/alpha', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' }]
  const gitlab = { discover: async () => ({ repos: reposList.slice() }) }
  let engine

  before(() => {
    engine = createSyncEngine({ home, config, save: () => saved.push(JSON.parse(JSON.stringify(config))), gitlab, logger: quietLogger, validateUrl: allowLocal })
  })
  after(async () => {
    await engine.stop()
    rmSync(work, { recursive: true, force: true })
    cleanupHome(home)
  })

  test('a crashed half-mirror is detected and recreated', { timeout: 60000 }, async () => {
    const path = engine.mirrorPathOf('grp/alpha')
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'junk'), 'not a repo')
    const result = await engine.syncAll()
    assert.equal(result.synced, 1)
    assert.equal(engine.states()['grp/alpha'].status, 'idle')
    assert.equal(git(path, 'rev-parse', '--is-bare-repository'), 'true')
  })

  test('a failed clone leaves no half-mirror behind', { timeout: 60000 }, async () => {
    const path = engine.mirrorPathOf('grp/alpha')
    rmSync(path, { recursive: true, force: true })
    const missing = join(work, 'nonexistent-1401') // "1401" must not read as an auth failure
    const gitlabMissing = {
      discover: async () => ({ repos: [{ name: 'grp/alpha', sshUrl: missing, httpUrl: missing, defaultBranch: 'main', webUrl: 'x' }] }),
    }
    const engineMissing = createSyncEngine({ home, config, save: () => {}, gitlab: gitlabMissing, logger: quietLogger, validateUrl: allowLocal })
    try {
      const result = await engineMissing.syncAll()
      assert.equal(result.failed, 1)
      const state = engineMissing.states()['grp/alpha']
      assert.equal(state.status, 'error', 'a missing repo is an error, not an auth failure')
      assert.doesNotMatch(state.error, /needs/)
      assert.ok(!existsSync(path), 'partial clone was cleaned up')
    } finally {
      await engineMissing.stop()
    }
  })

  test('deselected repos are pruned only after two consecutive omissions', { timeout: 60000 }, async () => {
    // grp/gone was deselected before this engine started and carries a stale
    // override in config.mirrors. The recreate test's cycle already omitted
    // it once, so this cycle is the second strike.
    await engine.syncAll()
    assert.equal(config.mirrors['grp/gone'], undefined, 'stale override pruned')
    assert.ok(saved.some((c) => c.mirrors && !('grp/gone' in c.mirrors)), 'prune persisted via save()')

    // A repo that was synced and then deselected keeps its state for one
    // grace cycle before being pruned.
    reposList.push({ name: 'grp/beta', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' })
    await engine.syncAll()
    assert.equal(engine.states()['grp/beta'].status, 'idle')
    reposList.pop()
    await engine.syncAll() // first omission — previous discovery still knows beta
    assert.notEqual(engine.states()['grp/beta'], undefined, 'grace cycle keeps the state')
    await engine.syncAll() // second omission — both latest discoveries agree
    assert.equal(engine.states()['grp/beta'], undefined, 'state pruned after two omissions')
  })

  test('setBranch rejects names the engine has never seen', () => {
    assert.throws(() => engine.setBranch('grp/unknown', 'main'), /unknown mirror/)
    assert.equal(engine.setBranch('grp/alpha', 'release').branch, 'release')
  })
})

describe('auth failure handling', () => {
  const home = tempHome()
  const allowLocal = (url) => String(url).startsWith('/') || isValidRemoteUrl(url)
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const config = {
    gitlab: { selection: { type: 'repos', repos: ['grp/locked', 'grp/forbidden'] } },
    mirrors: {},
  }
  let server
  let port
  let engine
  let clock = 1_000_000

  before(async () => {
    // A git http remote that always demands (and rejects) credentials.
    server = createServer((req, res) => {
      if (req.url.includes('forbidden')) {
        res.writeHead(403)
        return res.end('forbidden')
      }
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end('denied')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
    const repos = [
      { name: 'grp/locked', sshUrl: `http://127.0.0.1:${port}/locked.git`, httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
      { name: 'grp/forbidden', sshUrl: `http://127.0.0.1:${port}/forbidden.git`, httpUrl: '', defaultBranch: 'main', webUrl: 'x' },
    ]
    const gitlab = { discover: async () => ({ repos }) }
    engine = createSyncEngine({
      home, config, save: () => {}, gitlab, logger,
      now: () => clock,
      validateUrl: allowLocal,
    })
  })
  after(async () => {
    await engine.stop()
    server.close()
    cleanupHome(home)
  })

  test('401 and 403 clones mark the repo needs-auth with an error trail', { timeout: 60000 }, async () => {
    const result = await engine.syncAll()
    assert.equal(result.synced, 0)
    assert.equal(result.failed, 2)
    for (const name of ['grp/locked', 'grp/forbidden']) {
      const state = engine.states()[name]
      assert.equal(state.status, 'needs-auth', name)
      assert.ok(state.error.length > 0, 'remediation error surfaced')
      assert.ok(state.backoffUntil > clock, 'backoff scheduled')
    }
  })

  test('exponential backoff suppresses retries on the poll cycle', { timeout: 60000 }, async () => {
    const result = await engine.pollCycle()
    assert.equal(result.synced, 0, 'backed-off repos are skipped by the poll cycle')
    // A manual "Sync now" is explicit user intent — it must not be swallowed
    // by the backoff window.
    const manual = await engine.syncAll()
    assert.equal(manual.failed, 2, 'manual sync overrides backoff')
    clock += 61 * 60 * 1000 // past the 60m schedule ceiling
    const again = await engine.pollCycle()
    assert.equal(again.failed, 2, 'retry fires once the backoff window passes')
    assert.equal(engine.states()['grp/locked'].status, 'needs-auth')
  })

  test('auth failure on the FETCH path still classifies needs-auth (regression)', { timeout: 60000 }, async () => {
    // Clone succeeds with valid credentials; the credential then breaks
    // upstream (rotated PAT, removed ssh key) — `git remote update` reports
    // exit 1 (not clone's 128), which is the case §7.3 exists for.
    const work = mkdtempSync(join(tmpdir(), 'baize-sync-fetchauth-'))
    const home2 = tempHome()
    const source = makeSourceRepo(work)
    const config2 = { gitlab: { selection: { type: 'repos', repos: ['grp/cred'] } }, mirrors: {} }
    const gitlab2 = {
      discover: async () => ({ repos: [{ name: 'grp/cred', sshUrl: source, httpUrl: source, defaultBranch: 'main', webUrl: 'x' }] }),
    }
    const engine2 = createSyncEngine({ home: home2, config: config2, save: () => {}, gitlab: gitlab2, logger, validateUrl: allowLocal })
    try {
      const first = await engine2.syncAll()
      assert.equal(first.synced, 1)
      execFileSync('git', ['-C', engine2.mirrorPathOf('grp/cred'), 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/rotated.git`], { encoding: 'utf8' })
      const second = await engine2.syncAll()
      assert.equal(second.failed, 1)
      assert.equal(engine2.states()['grp/cred'].status, 'needs-auth', 'fetch-path auth failure (exit code 1)')
    } finally {
      await engine2.stop()
      rmSync(work, { recursive: true, force: true })
      cleanupHome(home2)
    }
  })
})

describe('git child lifecycle', () => {
  const home = tempHome()
  let server
  let port
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  before(async () => {
    // Accepts the connection and never answers — a hung upstream.
    server = createServer(() => {})
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  })
  after(async () => {
    server.close()
    cleanupHome(home)
  })

  const makeEngine = (overrides = {}) => {
    const url = `http://127.0.0.1:${port}/hang.git`
    const config = { gitlab: { selection: { type: 'repos', repos: ['grp/hang'] } }, mirrors: {} }
    const gitlab = { discover: async () => ({ repos: [{ name: 'grp/hang', sshUrl: url, httpUrl: url, defaultBranch: 'main', webUrl: 'x' }] }) }
    return createSyncEngine({ home, config, save: () => {}, gitlab, logger, ...overrides })
  }

  test('a hung git operation times out instead of wedging the queue', { timeout: 60000 }, async () => {
    const engine = makeEngine({ gitTimeoutMs: 500 })
    try {
      await engine.syncAll()
      const state = engine.states()['grp/hang']
      assert.equal(state.status, 'error')
      assert.match(state.error, /timed out/)
      // The queue must be free again: the next cycle returns promptly.
      const again = await engine.syncAll()
      assert.equal(again.failed, 1)
    } finally {
      await engine.stop()
    }
  })

  test('stop() kills an in-flight clone instead of waiting it out', { timeout: 60000 }, async () => {
    const engine = makeEngine({ gitTimeoutMs: 60_000 })
    const url = `http://127.0.0.1:${port}/hang.git`
    const pending = engine.syncAll()
    await sleep(500) // let the clone spawn and connect
    const started = Date.now()
    await Promise.race([engine.stop(), sleep(5000).then(() => 'slow')])
    const stopped = Date.now() - started
    assert.ok(stopped < 5000, `stop() resolved in ${stopped}ms`)
    await pending.catch(() => {})
    const survivors = spawnSync('pgrep', ['-f', `clone --mirror -- ${url}`], { encoding: 'utf8' })
    assert.equal(survivors.stdout.trim(), '', 'no orphaned git clone survives stop()')
  })
})
