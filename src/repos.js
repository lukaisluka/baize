import { spawnSync } from 'node:child_process'
import { basename, isAbsolute, resolve } from 'node:path'

function slugify(path) {
  return (
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo'
  )
}

// A git repo for CBM purposes is anything `git rev-parse --git-dir` accepts —
// work trees and the bare mirrors that fleet sync (#12) will create alike.
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
// config.repos (name -> { path, addedAt }) so they survive restarts; job state
// is in-memory and re-derived from CBM's index_status after a restart.
// Status vocabulary: 'indexing' | 'ready' | 'error' | 'unindexed'.
export function createRepoRegistry({ config, save, logger, cbm }) {
  const jobs = new Map() // name -> { status, error?, stats? }

  function uniqueName(base) {
    const names = new Set(Object.keys(config.repos))
    if (!names.has(base)) return base
    let i = 2
    while (names.has(`${base}-${i}`)) i++
    return `${base}-${i}`
  }

  // Fire-and-forget: kicks the index job if one is not already running for the
  // repo. Re-submissions while a job runs (reindex, re-POST of a registered
  // path) collapse into the running job instead of enqueuing a second index.
  function kickIndex(name) {
    const job = jobs.get(name)
    if (job?.status === 'indexing') return job

    const entry = config.repos[name]
    const record = { status: 'indexing' }
    jobs.set(name, record)
    logger.info(`repos: indexing ${name} (${entry.path})`)

    cbm
      .call('index_repository', { repo_path: entry.path, name })
      .then((result) => {
        record.status = 'ready'
        record.stats = { nodes: result?.nodes, edges: result?.edges }
        record.indexedAt = new Date().toISOString()
        logger.info(`repos: indexed ${name} (${result?.nodes ?? '?'} nodes, ${result?.edges ?? '?'} edges)`)
      })
      .catch((err) => {
        record.status = 'error'
        record.error = err.message
        logger.error(`repos: indexing ${name} failed: ${err.message}`)
      })
    return record
  }

  function add(rawPath, rawName) {
    const path = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
    // Re-submitting a path already registered is a no-op returning the
    // existing entry — never a second registry entry indexing the same tree.
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

  async function describe(name, entry) {
    const job = jobs.get(name)
    const base = { name, path: entry.path, addedAt: entry.addedAt }
    if (job) {
      return { ...base, status: job.status, error: job.error, stats: job.stats, indexedAt: job.indexedAt }
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
        return { ...base, status: 'unindexed' }
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
    return kickIndex(name)
  }

  return { add, list, reindex }
}
