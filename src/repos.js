import { spawnSync } from 'node:child_process'
import { basename, resolve } from 'node:path'

function slugify(path) {
  return (
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo'
  )
}

// A git repo for CBM purposes is anything `git rev-parse --git-dir` accepts —
// work trees and the bare mirrors that fleet sync (#12) creates alike.
// Distinguishes "not a repo" (400) from "git missing" (500) so the real
// cause is never masked.
function checkGitRepo(path) {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--git-dir'], { encoding: 'utf8' })
  if (result.error) {
    const err = new Error(`git is not available: ${result.error.message}`)
    err.statusCode = 500
    return err
  }
  if (result.status !== 0) {
    const err = new Error(`not a git repository: ${path}`)
    err.statusCode = 400
    return err
  }
  return null
}

// Repo registry + one background index job per repo. Registered repos live in
// config.repos (name -> { path, addedAt, mirror?, lastIndexedRevision? }) so
// they survive restarts; job state is in-memory and re-derived from CBM's
// index_status after a restart. Status vocabulary: 'indexing' | 'ready' |
// 'error' | 'unindexed'. Failed index jobs retry on the same exponential
// schedule fleet sync uses; a scheduled retry carries the newest revision it
// saw, so re-kicks while waiting collapse into it instead of stacking.
const RETRY_SCHEDULE_MINUTES = [1, 5, 15, 60, 240, 1440]

export function createRepoRegistry({
  config,
  save,
  logger,
  cbm,
  retryDelaysMs = RETRY_SCHEDULE_MINUTES.map((m) => m * 60 * 1000),
  now = Date.now,
}) {
  const jobs = new Map() // name -> { status, error?, stats?, retryAttempt, retryTimer?, retryAt?, pendingRevision? }
  let stopped = false

  function uniqueName(base) {
    const names = new Set(Object.keys(config.repos))
    if (!names.has(base)) return base
    let i = 2
    while (names.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  // Fire-and-forget: kicks the index job if one is not already running for
  // the repo. Re-submissions while a job runs (reindex, re-POST of a
  // registered path, a new synced revision) collapse into the running job
  // instead of enqueuing a second index; while a retry is scheduled they
  // just retarget it. With a revision, the job is idempotent: re-kicking
  // the exact revision that was last indexed is a no-op.
  function kickIndex(name, { revision = null, force = false } = {}) {
    const entry = config.repos[name]
    const job = jobs.get(name) ?? { status: 'ready' }
    if (job.status === 'indexing') {
      // Collapse into the running job, but remember the newest revision seen:
      // if the run completes on an older one, completion re-kicks immediately.
      job.latestRevision = revision ?? job.latestRevision
      return job
    }
    if (job.retryTimer && !force) {
      job.pendingRevision = revision ?? job.pendingRevision
      return job
    }
    if (job.retryTimer) {
      clearTimeout(job.retryTimer)
      job.retryTimer = null
      job.retryAt = null
      // The forced run supersedes the scheduled retry — inherit its target.
      // Dropping it would make the retry-fallback below aim at an
      // already-indexed revision, which the idempotency guard turns into a
      // silent no-op: the job would sit in 'error' forever.
      revision = revision ?? job.pendingRevision
    }
    if (stopped) return job
    if (!force && revision && entry.lastIndexedRevision === revision) return job

    const record = { status: 'indexing', retryAttempt: job.retryAttempt ?? 0, latestRevision: revision }
    jobs.set(name, record)
    logger.info(`repos: indexing ${name} (${entry.path}${revision ? ` @ ${revision.slice(0, 10)}` : ''})`)

    cbm
      .call('index_repository', { repo_path: entry.path, name })
      .then((result) => {
        record.status = 'ready'
        record.error = null
        record.stats = { nodes: result?.nodes, edges: result?.edges }
        record.indexedAt = new Date().toISOString()
        record.retryAttempt = 0
        if (revision) {
          entry.lastIndexedRevision = revision
          save()
        }
        logger.info(`repos: indexed ${name} (${result?.nodes ?? '?'} nodes, ${result?.edges ?? '?'} edges)`)
        // A newer revision arrived while this run was in flight — index it
        // now instead of waiting for the next sync cycle to notice.
        if (record.latestRevision && record.latestRevision !== revision) {
          kickIndex(name, { revision: record.latestRevision })
        }
      })
      .catch((err) => {
        record.status = 'error'
        record.error = err.message
        logger.error(`repos: indexing ${name} failed: ${err.message}`)
        // Retry the revision this run targeted — never entry.lastIndexedRevision:
        // an already-indexed revision is by definition not a valid retry
        // target (the idempotency guard would swallow it).
        scheduleRetry(name, record.latestRevision ?? null, record)
      })
    return record
  }

  function scheduleRetry(name, revision, record) {
    if (stopped) return
    const delayMs = retryDelaysMs[Math.min(record.retryAttempt, retryDelaysMs.length - 1)]
    record.retryAttempt += 1
    record.retryAt = now() + delayMs
    record.pendingRevision = revision
    record.retryTimer = setTimeout(() => {
      record.retryTimer = null
      record.retryAt = null
      if (stopped) return
      kickIndex(name, { revision: record.pendingRevision ?? null })
    }, delayMs)
    record.retryTimer.unref()
    logger.warn(`repos: retrying ${name} index in ${Math.round(delayMs / 1000)}s (attempt ${record.retryAttempt})`)
  }

  function add(rawPath, rawName) {
    // resolve() normalizes (absolute, no trailing slash) so the same repo
    // submitted as /x/repo and /x/repo/ dedupes to one registry entry.
    const path = resolve(rawPath)
    // Re-submitting a registered path returns the existing entry and re-kicks
    // indexing if idle — never a second entry indexing the same tree.
    const existing = Object.entries(config.repos).find(([, entry]) => entry.path === path)
    if (existing) {
      const [name] = existing
      kickIndex(name)
      return { name, path, alreadyRegistered: true }
    }

    const failure = checkGitRepo(path)
    if (failure) throw failure

    const base = typeof rawName === 'string' && rawName.trim() ? slugify(rawName) : slugify(path)
    const name = uniqueName(base)
    config.repos[name] = { path, addedAt: new Date().toISOString() }
    save()
    kickIndex(name)
    return { name, path }
  }

  // Fleet mirrors (#13): bare mirrors under ~/.baize/repos owned by GitLab
  // project names. Registered with the exact GitLab name so the CBM project
  // identity is stable across restarts; a manually-added repo owning the
  // same name wins and the mirror takes a suffix. Called by the sync engine
  // whenever a mirror lands on a revision its index has not seen.
  function ensureFleetRepo(rawName, path, revision) {
    // Reuse only an entry this project already owns (mirror entry at the
    // same deterministic worktree path). A suffixed fleet entry can collide
    // with a real GitLab project of that exact name — re-pointing it would
    // index one project's tree under another's CBM identity, so a path
    // mismatch registers fresh under the next free suffix instead.
    let name = rawName
    let entry = config.repos[name]
    if (entry && (entry.mirror !== true || entry.path !== path)) {
      name = uniqueName(rawName)
      entry = config.repos[name]
    }
    if (!entry) {
      config.repos[name] = { path, addedAt: new Date().toISOString(), mirror: true }
      save()
    }
    if (stopped) return
    kickIndex(name, { revision })
  }

  async function describe(name, entry) {
    const job = jobs.get(name)
    const base = {
      name,
      path: entry.path,
      addedAt: entry.addedAt,
      mirror: Boolean(entry.mirror),
      lastIndexedRevision: entry.lastIndexedRevision ?? null,
    }
    if (job) {
      return {
        ...base,
        status: job.status,
        error: job.error,
        stats: job.stats,
        indexedAt: job.indexedAt,
        retryAt: job.retryAt ?? null,
      }
    }
    // No local job (fresh restart): derive from CBM's own state. CBM's
    // status field leads ('ready', or its own in-progress wording); only a
    // real "not indexed" maps to unindexed — any other failure (CBM down,
    // timeout) surfaces as an error rather than masquerading as a fresh repo.
    try {
      const status = await cbm.call('index_status', { project: name }, { timeoutMs: 30000 })
      return {
        ...base,
        status: status?.status ?? 'ready',
        stats: { nodes: status?.nodes, edges: status?.edges },
      }
    } catch (err) {
      if (/not found or not indexed/.test(err.message)) {
        // CBM's index is the truth; the config token must yield. A cleared or
        // corrupted ~/.baize/index would otherwise pin lastIndexedRevision
        // forever while this very status honestly says 'unindexed' — and the
        // idempotency guard would turn every future kick for that revision
        // into a no-op. Drop the stale token and rebuild the index.
        const token = entry.lastIndexedRevision
        if (token) {
          delete entry.lastIndexedRevision
          save()
          if (!stopped) {
            logger.warn(`repos: ${name} index missing in CBM (config claimed ${token.slice(0, 10)}) — re-indexing`)
            kickIndex(name, { revision: token })
          }
        }
        return { ...base, lastIndexedRevision: null, status: 'unindexed' }
      }
      return { ...base, status: 'error', error: err.message }
    }
  }

  async function list() {
    return Promise.all(Object.entries(config.repos).map(([name, entry]) => describe(name, entry)))
  }

  function reindex(name) {
    if (!config.repos[name]) {
      const err = new Error(`unknown repo: ${name}`)
      err.statusCode = 404
      throw err
    }
    return kickIndex(name, { force: true })
  }

  function stop() {
    // Retry timers must not outlive the app: clear them before CBM is torn
    // down, and stop accepting new kicks (in-flight calls rejecting during
    // cbm.stop() must not schedule fresh retries).
    stopped = true
    for (const job of jobs.values()) {
      if (job.retryTimer) {
        clearTimeout(job.retryTimer)
        job.retryTimer = null
      }
    }
  }

  return { add, ensureFleetRepo, list, reindex, stop }
}
