import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig, saveConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { ensureDataLayout } from '../src/paths.js'
import { createRepoRegistry } from '../src/repos.js'
import { cleanupHome, tempHome } from './helpers.js'

function gitFixture(dir) {
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return dir
}

function makeRegistry(home, { cbm: cbmOverride, retryDelaysMs } = {}) {
  const config = loadConfig(home)
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const calls = []
  const cbm = cbmOverride ?? {
    call: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'index_repository') return { nodes: 6, edges: 9, status: 'indexed' }
      if (tool === 'index_status') return { nodes: 6, edges: 9, status: 'ready' }
      throw new Error(`unexpected tool ${tool}`)
    },
  }
  const registry = createRepoRegistry({
    config,
    save: () => saveConfig(home, config),
    logger,
    cbm,
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
  })
  return { registry, config, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(20)
  }
  throw new Error('waitFor: condition not met within timeout')
}

test('add(): validates git repo, slugs the name, persists, kicks index', async () => {
  const home = tempHome()
  try {
    const { registry, calls } = makeRegistry(home)
    const added = registry.add(gitFixture(join(home, 'My Repo!')))

    assert.equal(added.name, 'my-repo')
    assert.match(added.path, /My Repo!$/)
    await tick()
    assert.deepEqual(
      calls.find((c) => c.tool === 'index_repository')?.args,
      { repo_path: added.path, name: 'my-repo' },
    )
    const persisted = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.ok(persisted.repos['my-repo'].path)
  } finally {
    cleanupHome(home)
  }
})

test('add(): non-git path fails fast with 400', async () => {
  const home = tempHome()
  try {
    const { registry, config } = makeRegistry(home)
    assert.throws(() => registry.add(join(home, 'plain-dir')), (err) => {
      assert.equal(err.statusCode, 400)
      return true
    })
    assert.equal(Object.keys(config.repos).length, 0)
  } finally {
    cleanupHome(home)
  }
})

test('add(): colliding names get a unique suffix; explicit name respected', async () => {
  const home = tempHome()
  try {
    const { registry } = makeRegistry(home)
    const first = registry.add(gitFixture(join(home, 'a', 'svc')))
    const second = registry.add(gitFixture(join(home, 'b', 'svc')))
    const named = registry.add(gitFixture(join(home, 'c', 'svc')), 'billing')
    assert.equal(first.name, 'svc')
    assert.equal(second.name, 'svc-2')
    assert.equal(named.name, 'billing')
  } finally {
    cleanupHome(home)
  }
})

test('add(): re-submitting a registered path returns the existing entry, no duplicate', async () => {
  const home = tempHome()
  try {
    const { registry, config } = makeRegistry(home)
    const fixture = gitFixture(join(home, 'svc'))
    const first = registry.add(fixture)
    const second = registry.add(fixture, 'other-name')
    // Trailing slash normalizes to the same entry too.
    const third = registry.add(`${fixture}/`)
    assert.equal(second.name, first.name)
    assert.equal(third.name, first.name)
    assert.equal(second.alreadyRegistered, true)
    assert.deepEqual(Object.keys(config.repos), [first.name])
  } finally {
    cleanupHome(home)
  }
})

test('reindex() while indexing collapses into the running job', async () => {
  const home = tempHome()
  try {
    const { registry, calls } = makeRegistry(home)
    registry.add(gitFixture(join(home, 'svc')))
    registry.reindex('svc')
    registry.reindex('svc')
    await tick()
    assert.equal(calls.filter((c) => c.tool === 'index_repository').length, 1)
  } finally {
    cleanupHome(home)
  }
})

test('list(): job stats while running; derived from index_status after restart', async () => {
  const home = tempHome()
  try {
    const { registry, calls } = makeRegistry(home)
    registry.add(gitFixture(join(home, 'svc')))
    await tick()

    const [live] = await registry.list()
    assert.equal(live.status, 'ready')
    assert.deepEqual(live.stats, { nodes: 6, edges: 9 })

    // Simulate a restart: same config on disk, fresh registry, no job state.
    const logger = createLogger(ensureDataLayout(home).logs)
    const cbm = {
      call: async (tool) => (tool === 'index_status' ? { nodes: 6, edges: 9 } : null),
    }
    const config2 = loadConfig(home)
    const fresh = createRepoRegistry({ config: config2, save: () => {}, logger, cbm })
    const [restored] = await fresh.list()
    assert.equal(restored.status, 'ready')
    assert.deepEqual(restored.stats, { nodes: 6, edges: 9 })
    assert.ok(calls.length > 0)
  } finally {
    cleanupHome(home)
  }
})

test('list(): unknown project surfaces as unindexed; CBM failure as error', async () => {
  const home = tempHome()
  try {
    const config = loadConfig(home)
    config.repos = {
      ghost: { path: '/gone/nowhere', addedAt: '2026-01-01T00:00:00Z' },
      stuck: { path: '/x/stuck', addedAt: '2026-01-01T00:00:00Z' },
    }
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const cbm = {
      call: async (tool, args) => {
        if (args.project === 'ghost') throw new Error('index_status: project not found or not indexed')
        throw new Error('index_status: timed out after 30000ms')
      },
    }
    const registry = createRepoRegistry({ config, save: () => {}, logger, cbm })
    const repos = await registry.list()
    const byName = Object.fromEntries(repos.map((r) => [r.name, r]))
    assert.equal(byName.ghost.status, 'unindexed')
    assert.equal(byName.stuck.status, 'error')
    assert.match(byName.stuck.error, /timed out/)
  } finally {
    cleanupHome(home)
  }
})

test('index failure is captured as status=error with the message', async () => {
  const home = tempHome()
  try {
    const config = loadConfig(home)
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const cbm = {
      call: async (tool) => {
        if (tool === 'index_repository') throw new Error('index_repository: boom')
        throw new Error('unexpected')
      },
    }
    const registry = createRepoRegistry({ config, save: () => {}, logger, cbm, retryDelaysMs: [60_000_000] })
    registry.add(gitFixture(join(home, 'svc')))
    await tick()
    const [repo] = await registry.list()
    assert.equal(repo.status, 'error')
    assert.match(repo.error, /boom/)
    assert.ok(repo.retryAt, 'a retry is scheduled')
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('fleet mirror: registered under its GitLab name and indexed with the revision', async () => {
  const home = tempHome()
  try {
    const { registry, config, calls } = makeRegistry(home)
    registry.ensureFleetRepo('grp/alpha', join(home, 'repos', 'grp-alpha-1a2b3c4d.git'), 'a'.repeat(40))
    await tick()
    assert.equal(config.repos['grp/alpha'].mirror, true)
    assert.equal(config.repos['grp/alpha'].lastIndexedRevision, 'a'.repeat(40), 'indexed revision persisted')
    assert.deepEqual(
      calls.find((c) => c.tool === 'index_repository')?.args,
      { repo_path: join(home, 'repos', 'grp-alpha-1a2b3c4d.git'), name: 'grp/alpha' },
    )
    // survives on disk
    const persisted = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
    assert.equal(persisted.repos['grp/alpha'].lastIndexedRevision, 'a'.repeat(40))
  } finally {
    cleanupHome(home)
  }
})

test('fleet mirror: same revision is idempotent, a new revision re-indexes', async () => {
  const home = tempHome()
  try {
    const { registry, calls } = makeRegistry(home)
    registry.ensureFleetRepo('grp/alpha', join(home, 'm.git'), 'a'.repeat(40))
    await tick()
    registry.ensureFleetRepo('grp/alpha', join(home, 'm.git'), 'a'.repeat(40)) // no-op
    await tick()
    assert.equal(calls.filter((c) => c.tool === 'index_repository').length, 1)

    registry.ensureFleetRepo('grp/alpha', join(home, 'm.git'), 'b'.repeat(40)) // new revision
    await tick()
    assert.equal(calls.filter((c) => c.tool === 'index_repository').length, 2)
  } finally {
    cleanupHome(home)
  }
})

test('fleet mirror: name clash with a manual repo resolves to a suffix, not a takeover', async () => {
  const home = tempHome()
  try {
    const { registry, config } = makeRegistry(home)
    // A top-level GitLab project can be literally named "alpha", the same as
    // a slugified manual repo — the manual entry must keep the name.
    registry.add(gitFixture(join(home, 'alpha')))
    registry.ensureFleetRepo('alpha', join(home, 'mirror.git'), 'a'.repeat(40))
    await tick()
    assert.equal(config.repos['alpha'].mirror, undefined, 'manual entry untouched')
    assert.equal(config.repos['alpha-2'].mirror, true, 'fleet repo suffixed')
  } finally {
    cleanupHome(home)
  }
})

test('fleet mirror: failed index retries with the newest revision it saw', async () => {
  const home = tempHome()
  try {
    let fail = true
    const calls = []
    const cbm = {
      call: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'index_repository') {
          if (fail) throw new Error('index_repository: daemon wedged')
          return { nodes: 1, edges: 2 }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    }
    const { registry, config } = makeRegistry(home, { cbm, retryDelaysMs: [15, 15] })
    registry.ensureFleetRepo('grp/flaky', join(home, 'm.git'), 'a'.repeat(40))
    await waitFor(() => config.repos['grp/flaky'] !== undefined)
    // First attempt failed while revision 'b' landed: the retry must target
    // the newest revision, not the one that failed.
    registry.ensureFleetRepo('grp/flaky', join(home, 'm.git'), 'b'.repeat(40))
    await waitFor(() => calls.filter((c) => c.tool === 'index_repository').length >= 1)
    fail = false
    await waitFor(async () => (await registry.list()).find((r) => r.name === 'grp/flaky')?.status === 'ready')
    const indexCalls = calls.filter((c) => c.tool === 'index_repository')
    assert.ok(indexCalls.length >= 2, 'at least one retry fired')
    assert.equal(config.repos['grp/flaky'].lastIndexedRevision, 'b'.repeat(40), 'retry indexed the newest revision')
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('a revision arriving mid-run re-indexes on completion instead of being dropped', async () => {
  const home = tempHome()
  try {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const calls = []
    const cbm = {
      call: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'index_repository') {
          await gate
          return { nodes: 1, edges: 1 }
        }
        return { nodes: 1, edges: 1, status: 'ready' }
      },
    }
    const { registry, config } = makeRegistry(home, { cbm })
    registry.ensureFleetRepo('grp/alpha', join(home, 'm.git'), 'a'.repeat(40)) // starts run on 'a'
    registry.ensureFleetRepo('grp/alpha', join(home, 'm.git'), 'b'.repeat(40)) // collapses into the run
    release()
    await waitFor(async () => config.repos['grp/alpha'].lastIndexedRevision === 'b'.repeat(40))
    assert.equal(calls.filter((c) => c.tool === 'index_repository').length, 2, 'completion re-kicked for the newer revision')
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('forced reindex failure does not strand the retry chain (P1 regression)', async () => {
  const home = tempHome()
  try {
    let fail = false
    const calls = []
    const cbm = {
      call: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'index_repository') {
          if (fail) throw new Error('index_repository: daemon down')
          return { nodes: 1, edges: 1 }
        }
        throw new Error(`unexpected tool ${tool}`)
      },
    }
    const { registry, config } = makeRegistry(home, { cbm, retryDelaysMs: [15, 15] })
    const statusOf = async () => (await registry.list()).find((r) => r.name === 'grp/x')?.status
    registry.ensureFleetRepo('grp/x', join(home, 'm.git'), 'a'.repeat(40))
    await waitFor(() => config.repos['grp/x'].lastIndexedRevision === 'a'.repeat(40))

    // Revision 'b' lands while CBM is down: kick fails, retry scheduled for 'b'.
    fail = true
    registry.ensureFleetRepo('grp/x', join(home, 'm.git'), 'b'.repeat(40))
    await waitFor(async () => (await statusOf()) === 'error')
    // A forced reindex supersedes the scheduled retry — it must inherit 'b'
    // as its target, and its own failure must re-arm the retry for 'b'.
    registry.reindex('grp/x')
    await waitFor(async () => (await statusOf()) === 'error')

    fail = false // CBM recovers
    // The re-scheduled retry must actually run (not collapse into a no-op
    // against the already-indexed 'a') and bring the index to 'b'.
    await waitFor(() => config.repos['grp/x'].lastIndexedRevision === 'b'.repeat(40), { timeoutMs: 15000 })
    assert.equal(await statusOf(), 'ready')
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('a stale lastIndexedRevision token yields to a missing CBM index and rebuilds', async () => {
  const home = tempHome()
  try {
    const calls = []
    const cbm = {
      call: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'index_status') throw new Error('index_status: project not found or not indexed')
        if (tool === 'index_repository') return { nodes: 2, edges: 2 }
        throw new Error(`unexpected tool ${tool}`)
      },
    }
    const { registry, config } = makeRegistry(home, { cbm })
    // Restart scenario: config survived, CBM's index dir did not.
    config.repos = {
      'grp/ghost': { path: join(home, 'm.git'), addedAt: '2026-01-01T00:00:00Z', mirror: true, lastIndexedRevision: 'a'.repeat(40) },
    }
    const [repo] = await registry.list()
    assert.equal(repo.status, 'unindexed')
    assert.equal(repo.lastIndexedRevision, null, 'stale token is not reported as truth')
    // The rebuild was kicked for the stale token's revision.
    await waitFor(() => calls.some((c) => c.tool === 'index_repository'))
    assert.deepEqual(calls.find((c) => c.tool === 'index_repository').args, {
      repo_path: join(home, 'm.git'),
      name: 'grp/ghost',
    })
    // On success the token is re-recorded — from CBM's own result this time,
    // not from the stale config value.
    await waitFor(async () => (await registry.list()).find((r) => r.name === 'grp/ghost')?.status === 'ready')
    assert.equal(config.repos['grp/ghost'].lastIndexedRevision, 'a'.repeat(40))
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('fleet mirror: a suffixed entry is never re-pointed to a different project', async () => {
  const home = tempHome()
  try {
    const { registry, config } = makeRegistry(home)
    registry.add(gitFixture(join(home, 'alpha'))) // manual 'alpha' wins the base name
    registry.ensureFleetRepo('alpha', join(home, 'wt-alpha'), 'a'.repeat(40)) // fleet → 'alpha-2'
    await tick()
    // A real GitLab project literally named alpha-2 shows up later: it must
    // not hijack (re-point) the existing 'alpha-2' entry — it takes the next
    // free suffix, and the first project keeps its CBM identity.
    registry.ensureFleetRepo('alpha-2', join(home, 'wt-alpha-2'), 'c'.repeat(40))
    await tick()
    assert.equal(config.repos['alpha-2'].path, join(home, 'wt-alpha'), 'first project keeps its entry')
    assert.equal(config.repos['alpha-2-2'].path, join(home, 'wt-alpha-2'), 'newcomer suffixed, not re-pointing')
    assert.equal(config.repos['alpha-2-2'].mirror, true)
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})

test('list() stays responsive while an index job runs (query path)', async () => {
  const home = tempHome()
  try {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const cbm = {
      call: async (tool) => {
        if (tool === 'index_repository') {
          await gate // simulate a long-running index
          return { nodes: 1, edges: 1 }
        }
        return { nodes: 1, edges: 1, status: 'ready' }
      },
    }
    const { registry } = makeRegistry(home, { cbm })
    registry.add(gitFixture(join(home, 'svc')))
    // list() answers with 'indexing' without waiting for the job to finish.
    const listed = await Promise.race([
      registry.list(),
      sleep(1000).then(() => 'TIMEOUT'),
    ])
    assert.notEqual(listed, 'TIMEOUT')
    assert.equal(listed[0].status, 'indexing')
    release()
    registry.stop()
  } finally {
    cleanupHome(home)
  }
})
