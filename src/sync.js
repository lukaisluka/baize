import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

// Fleet sync (PRD §7.3–7.5): GitLab-discovered repositories cloned as bare
// mirrors under ~/.baize/repos/, kept current by polling + manual sync.
//
// Credentials: system git with the user's ambient setup (SSH agent / git
// credential helper). The GitLab PAT is NEVER embedded in a remote URL (§7.3)
// — discovery already proved API access; cloning rides whatever git is
// configured to use.
//
// Failure policy (§7.3): authentication failures mark the repo `needs-auth`
// and back off exponentially (never retry every poll). Other failures retry
// on the same schedule without the needs-auth marker.

const BACKOFF_SCHEDULE_MINUTES = [1, 5, 15, 60, 240, 1440]

const STATES = ['idle', 'cloning', 'fetching', 'needs-auth', 'error']

export function createSyncEngine({ home, config, save, gitlab, logger, now = Date.now }) {
  const reposDir = join(home, 'repos')
  const mirrors = new Map() // name -> { status, lastSyncAt?, lastRevision?, error?, backoffAttempt, backoffUntil? }
  const inFlight = new Set()
  let queue = Promise.resolve()
  let timer = null
  let started = false

  function stateOf(name) {
    return mirrors.get(name) ?? { status: 'idle', backoffAttempt: 0 }
  }

  function setState(name, patch) {
    const current = { status: 'idle', backoffAttempt: 0, ...mirrors.get(name) }
    mirrors.set(name, { ...current, ...patch })
  }

  function backoffMs(attempt) {
    const minutes = BACKOFF_SCHEDULE_MINUTES[Math.min(attempt, BACKOFF_SCHEDULE_MINUTES.length - 1)]
    return minutes * 60 * 1000
  }

  function git(args, cwd) {
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', (err2) => resolve({ ok: false, error: err2.message }))
      child.on('close', (code) =>
        resolve({ ok: code === 0, code, stderr: err, stdout: out }),
      )
    })
  }

  // git's wording varies by transport; every variant that means "your
  // credentials are the problem" maps to needs-auth so the UI can remediate.
  function isAuthFailure(result) {
    if (result.code === 128 || result.ok === false) {
      return /authentication|authorization|401|403|could not read [Uu]sername|permission denied|access denied|[Pp]ermission/i.test(
        `${result.stderr}`,
      )
    }
    return false
  }

  function mirrorPath(name) {
    return join(reposDir, `${name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.git`)
  }

  async function syncMirror(name, url) {
    if (inFlight.has(name)) return
    inFlight.add(name)
    const path = mirrorPath(name)
    const exists = existsSync(path)
    setState(name, { status: exists ? 'fetching' : 'cloning' })

    let result
    if (exists) {
      result = await git(['remote', 'update', '--prune'], path)
    } else {
      mkdirSync(reposDir, { recursive: true })
      // --mirror fetches all refs and leaves HEAD correctly pointing at the
      // source's default branch — no post-clone fixup needed.
      result = await git(['clone', '--mirror', url, path])
    }

    inFlight.delete(name)
    if (result.ok) {
      const branch = config.mirrors?.[name]?.branch
      const revision = await headRevision(path, branch)
      setState(name, {
        status: 'idle',
        lastSyncAt: now(),
        lastRevision: revision,
        error: null,
        backoffAttempt: 0,
        backoffUntil: null,
      })
      logger?.info(`sync: ${name} ${exists ? 'fetched' : 'cloned'} @ ${revision ?? 'unknown'}`)
      return
    }

    const auth = isAuthFailure(result)
    const state = stateOf(name)
    const attempt = state.backoffAttempt + 1
    setState(name, {
      status: auth ? 'needs-auth' : 'error',
      error: `${result.stderr || result.error || `git exited ${result.code}`}`.trim().split('\n').slice(-3).join('\n').slice(0, 500),
      backoffAttempt: attempt,
      backoffUntil: now() + backoffMs(attempt),
    })
    logger?.warn(`sync: ${name} failed (${auth ? 'auth' : 'error'}), backing off ${backoffMs(attempt) / 60000}m`)
  }

  async function headRevision(path, branch) {
    const result = await git(
      branch ? ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`] : ['rev-parse', '--verify', '--quiet', 'HEAD'],
      path,
    )
    return result.ok && /^[0-9a-f]+$/.test(result.stdout.trim()) ? result.stdout.trim() : null
  }

  function dueForSync(name) {
    const state = stateOf(name)
    if (state.backoffUntil && now() < state.backoffUntil) return false
    return true
  }

  // Discover (selection) -> sync each mirror. Serialized: one git at a time
  // keeps localhost and any upstream calm; parallelism is a later concern.
  async function runCycle({ manual = false, only } = {}) {
    if (!config.gitlab?.selection) return { synced: 0, reason: 'no selection' }
    let repos = []
    try {
      const result = config.gitlab.selection.type === 'group'
        ? await gitlab.discover({ group: config.gitlab.selection.path })
        : await gitlab.discover({ repos: config.gitlab.selection.repos })
      repos = result.repos.map((r) => ({ name: r.name, url: r.sshUrl || r.httpUrl }))
    } catch (err) {
      logger?.warn(`sync: discovery failed: ${err.message}`)
      if (manual) throw err
      return { synced: 0, reason: err.code ?? 'discovery failed' }
    }

    let synced = 0
    for (const repo of repos) {
      if (only && repo.name !== only) continue
      // Manual sync (button / branch change) overrides backoff — the user
      // asked for it now; only the poll timer respects the backoff window.
      if (!manual && !dueForSync(repo.name)) continue
      await syncMirror(repo.name, repo.url)
      synced += 1
    }
    return { synced }
  }

  return {
    STATES,
    stateOf,
    states() {
      const out = {}
      for (const [name, state] of mirrors) {
        out[name] = { ...state, branch: config.mirrors?.[name]?.branch ?? null }
      }
      return out
    },
    pollIntervalMinutes: () => Number(config.pollIntervalMinutes) || 15,
    // Per-repo branch override (§7.1): null resets to the repo's default.
    // The kick keeps `lastRevision` truthful: what's recorded must track the
    // configured branch immediately, not one poll later.
    setBranch(name, branch) {
      config.mirrors = config.mirrors ?? {}
      config.mirrors[name] = { ...(config.mirrors[name] ?? {}), branch }
      if (!config.mirrors[name].branch) {
        delete config.mirrors[name].branch
        if (Object.keys(config.mirrors[name]).length === 0) delete config.mirrors[name]
      }
      save()
      queue = queue.then(() => runCycle({ manual: true, only: name }).catch(() => {}))
      logger?.info(`sync: branch override for ${name}: ${branch ?? 'default'}`)
      return { name, branch: branch ?? null }
    },
    branchOf: (name) => config.mirrors?.[name]?.branch ?? null,
    syncNow: (name) => runCycle({ manual: true, only: name }),
    syncAll: () => runCycle({ manual: true }),
    // What the poll timer runs: same cycle, but respects backoff windows.
    pollCycle: () => runCycle(),
    mirrorPathOf: mirrorPath,
    start() {
      if (started) return
      started = true
      const minutes = Number(config.pollIntervalMinutes) || 15
      // Run one cycle at startup (staggered so a fleet page load sees life),
      // then on the poll interval.
      queue = queue.then(() => runCycle().catch(() => {}))
      timer = setInterval(() => {
        queue = queue.then(() => runCycle().catch(() => {}))
      }, minutes * 60 * 1000)
      timer.unref()
      logger?.info(`sync: polling every ${minutes}m`)
    },
    async stop() {
      if (timer) clearInterval(timer)
      started = false
      await queue.catch(() => {})
    },
  }
}
