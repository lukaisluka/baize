import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CbmSupervisor, resolveCbmBinary } from '../src/cbm.js'
import { createLogger } from '../src/logger.js'
import { ensureDataLayout } from '../src/paths.js'
import { cleanupHome, tempHome } from './helpers.js'

// End-to-end against the real CBM binary (installed by postinstall). Skipped
// with a reason when the binary is absent so `--ignore-scripts` dev setups
// and partial installs still run the rest of the suite.
let binary = null
try {
  binary = resolveCbmBinary()
} catch {
  // leave null — skip below
}

function gitFixture(dir) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  writeFileSync(
    join(dir, 'calc.go'),
    'package calc\n\n// Add returns the sum.\nfunc Add(a, b int) int { return a + b }\n',
  )
  execFileSync('git', ['-C', dir, 'add', 'calc.go'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
}

test(
  'CBM end-to-end: index fixture, query status, clean shutdown with no orphan daemon',
  { skip: binary ? false : 'CBM binary not installed' },
  async () => {
    const home = tempHome()
    const dirs = ensureDataLayout(home)
    const logger = createLogger(dirs.logs)
    const fixture = join(home, 'fixture-repo')
    gitFixture(fixture)

    const cbm = new CbmSupervisor({ cacheDir: dirs.index, logger })
    try {
      const result = await cbm.call('index_repository', {
        repo_path: fixture,
        name: 'fixture-it',
        mode: 'fast',
      })
      assert.equal(result.status, 'indexed')
      assert.ok(result.nodes > 0, `expected nodes > 0, got ${result.nodes}`)

      const status = await cbm.call('index_status', { project: 'fixture-it' }, { timeoutMs: 30000 })
      assert.equal(status.status, 'ready')
      assert.equal(status.nodes, result.nodes)

      const projects = await cbm.call('list_projects', {})
      assert.ok(projects.projects.some((p) => p.name === 'fixture-it'))
    } finally {
      await cbm.stop()
    }

    // No orphan daemon for our binary after stop(): poll briefly since the
    // daemon may take a moment to tear down after the stdio child exits.
    if (process.platform !== 'win32') {
      const pattern = `${binary} --cbm-daemon-internal`
      let gone = false
      for (let i = 0; i < 20 && !gone; i++) {
        const pgrep = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
        gone = pgrep.status !== 0
        if (!gone) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assert.ok(gone, 'CBM daemon should be gone after supervisor.stop()')
    }
    cleanupHome(home)
  },
)

test(
  'CBM stop() is a safe no-op when nothing was ever started',
  { skip: binary ? false : 'CBM binary not installed' },
  async () => {
    const home = tempHome()
    const dirs = ensureDataLayout(home)
    const cbm = new CbmSupervisor({ cacheDir: dirs.index, logger: { info: () => {} } })
    await cbm.stop()
    cleanupHome(home)
  },
)

test('resolveCbmBinary points at an existing file when installed', { skip: binary ? false : 'CBM binary not installed' }, () => {
  assert.ok(existsSync(binary))
})
