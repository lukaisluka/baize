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

function makeRegistry(home) {
  const config = loadConfig(home)
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const calls = []
  const cbm = {
    call: async (tool, args) => {
      calls.push({ tool, args })
      if (tool === 'index_repository') return { nodes: 6, edges: 9, status: 'indexed' }
      if (tool === 'index_status') return { nodes: 6, edges: 9, status: 'ready' }
      throw new Error(`unexpected tool ${tool}`)
    },
  }
  const registry = createRepoRegistry({ config, save: () => saveConfig(home, config), logger, cbm })
  return { registry, config, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

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
    const registry = createRepoRegistry({ config, save: () => {}, logger, cbm })
    registry.add(gitFixture(join(home, 'svc')))
    await tick()
    const [repo] = await registry.list()
    assert.equal(repo.status, 'error')
    assert.match(repo.error, /boom/)
  } finally {
    cleanupHome(home)
  }
})
