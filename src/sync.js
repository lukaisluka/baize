import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
//
// Remote URLs are attacker-controlled input: a compromised GitLab (or an
// http:// MITM) chooses what discovery returns. Only https/ssh/git URLs and
// scp-style user@host:path strings pass isValidRemoteUrl — transports that
// execute commands (ext::, fd::) or read arbitrary local paths never reach
// git, and `--` ends option parsing so a URL cannot masquerade as a flag.

const BACKOFF_SCHEDULE_MINUTES = [1, 5, 15, 60, 240, 1440]
const DEFAULT_GIT_TIMEOUT_MS = 10 * 60 * 1000

export function isValidRemoteUrl(url) {
  if (typeof url !== 'string' || url.startsWith('-')) return false
  // Printable ASCII only: a NUL or control byte inside a URL makes spawn()
  // throw synchronously, which must never depend on the caller catching it.
  if (!/^[\x21-\x7E]+$/.test(url)) return false
  if (/^(?:https?|ssh|git):\/\/\S+$/i.test(url)) {
    // git itself refuses dash-leading hostnames (option smuggling); refuse
    // them here too so the defense does not hinge on the git version.
    return !url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').startsWith('-')
  }
  // scp style — what GitLab's ssh_url_to_repo looks like: git@host:group/proj.git
  return /^[A-Za-z0-9][A-Za-z0-9._-]*@\S+:\S+$/.test(url)
}

// git's own wording, anchored: substring matches like bare "401" misclassify
// unrelated failures (a repo path containing "401", progress counters).
const AUTH_FAILURE_PATTERNS = [
  /The requested URL returned error: 40[13]/, // HTTP 401/403 from the remote
  /Authentication failed/, // credential rejected (SSH / smart HTTP)
  /could not read [Uu]sername/, // HTTP auth prompt suppressed (non-interactive)
  /[Pp]ermission denied \((?:publickey|password)\)/, // SSH key/password rejected
]

// Checked for EVERY failure regardless of exit code: `git clone` reports auth
// failures as 128, but `git remote update` propagates them as 1 — the exit
// code is noise, the wording is the signal.
function isAuthFailure(result) {
  if (result.ok && !result.error) return false
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(result.stderr || ''))
}

export function createSyncEngine({
  home,
  config,
  save,
  gitlab,
  logger,
  now = Date.now,
  validateUrl = isValidRemoteUrl,
  gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
}) {
  const reposDir = join(home, 'repos')
  const mirrors = new Map() // name -> { status, lastSyncAt?, lastRevision?, error?, backoffAttempt, backoffUntil? }
  const inFlight = new Set()
  const children = new Set() // live git processes — killed on stop()
  let lastDiscovery = null // Set of repo names from the last successful discovery (two-strikes pruning + setBranch validation)
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

  // git spawns helpers (git-remote-http and friends) that inherit its stdio
  // pipes. Killing only the parent leaves the helpers holding the pipes, and
  // the child's 'close' event (which waits for stdio EOF) then never fires.
  // detached: true puts git in its own process group so a kill can take the
  // whole tree down. (POSIX only — on Windows the group-kill fallback covers
  // just the parent, so helpers could linger there.)
  function killTree(child, signal = 'SIGKILL') {
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch { /* already dead */ }
    }
  }

  function git(args, cwd) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      } catch (err) {
        // spawn() throws synchronously for hostile argv (e.g. NUL bytes) —
        // resolve as a git failure instead of rejecting past the caller.
        return resolve({ ok: false, error: `failed to start git: ${err.message}` })
      }
      children.add(child)
      let out = ''
      let err = ''
      let timedOut = false
      // A hung clone/fetch must never wedge the serial queue (and with it
      // every future cycle): bound every git operation.
      const killer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, gitTimeoutMs)
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (err += d))
      child.on('error', (err2) => {
        clearTimeout(killer)
        children.delete(child)
        resolve({ ok: false, error: err2.message })
      })
      child.on('close', (code) => {
        clearTimeout(killer)
        children.delete(child)
        if (timedOut) {
          return resolve({
            ok: false,
            code,
            stderr: err,
            error: `git ${args[0]} timed out after ${Math.round(gitTimeoutMs / 1000)}s`,
          })
        }
        resolve({ ok: code === 0, code, stderr: err, stdout: out })
      })
    })
  }

  // `grp/alpha` and `grp-alpha` are distinct GitLab projects but sanitize to
  // the same path — the hash suffix keeps every mirror owned by exactly one
  // project (P2 collision from the #12 review).
  function mirrorPath(name) {
    const slug = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
    const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
    return join(reposDir, `${slug}-${hash}.git`)
  }

  // A dir that is not a bare clone with an origin remote is crash debris from
  // a killed clone — `remote update` on it can never succeed, so wipe it.
  async function isHealthyMirror(path) {
    const bare = await git(['rev-parse', '--is-bare-repository'], path)
    if (!bare.ok || bare.stdout.trim() !== 'true') return false
    const remote = await git(['config', '--get', 'remote.origin.url'], path)
    return remote.ok && remote.stdout.trim().length > 0
  }

  // Outcomes feed the cycle count: 'ok' synced, 'fail' attempted and failed
  // (including refused URLs), 'skip' collapsed into an in-flight sync.
  async function syncMirror(name, url) {
    if (inFlight.has(name)) return 'skip'
    inFlight.add(name)
    try {
      if (!validateUrl(url)) {
        setState(name, {
          status: 'error',
          error: `rejected remote URL (only https/ssh/git URLs are allowed): ${url}`,
        })
        logger?.warn(`sync: ${name} rejected remote URL from discovery`)
        return 'fail'
      }

      const path = mirrorPath(name)
      let exists = existsSync(path)
      if (exists && !(await isHealthyMirror(path))) {
        logger?.warn(`sync: ${name} mirror is not a valid bare clone — recreating ${path}`)
        rmSync(path, { recursive: true, force: true })
        exists = false
      }
      setState(name, { status: exists ? 'fetching' : 'cloning' })

      let result
      if (exists) {
        result = await git(['remote', 'update', '--prune'], path)
      } else {
        mkdirSync(reposDir, { recursive: true })
        // --mirror fetches all refs and leaves HEAD correctly pointing at the
        // source's default branch; `--` ends option parsing so the URL can
        // never be consumed as a flag.
        result = await git(['clone', '--mirror', '--', url, path])
        // A killed clone (timeout, shutdown) must not leave a half-mirror on
        // disk that later cycles would try to fetch into.
        if (!result.ok) rmSync(path, { recursive: true, force: true })
      }

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
        return 'ok'
      }

      const auth = isAuthFailure(result)
      const state = stateOf(name)
      const attempt = state.backoffAttempt + 1
      setState(name, {
        status: auth ? 'needs-auth' : 'error',
        // result.error carries the engine-level cause (spawn failure, timeout)
        // — git's own stderr is the fallback, not the other way round.
        error: `${result.error || result.stderr || `git exited ${result.code}`}`.trim().split('\n').slice(-3).join('\n').slice(0, 500),
        backoffAttempt: attempt,
        backoffUntil: now() + backoffMs(attempt),
      })
      logger?.warn(`sync: ${name} failed (${auth ? 'auth' : 'error'}), backing off ${backoffMs(attempt) / 60000}m`)
      return 'fail'
    } finally {
      inFlight.delete(name)
    }
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

  // Discover (selection) -> sync each mirror. Every cycle runs on the serial
  // queue: one git at a time keeps localhost and any upstream calm, and the
  // HTTP handlers / poll timer / stop() all see the same ordering.
  async function runCycle({ manual = false, only } = {}) {
    if (!config.gitlab?.selection) return { synced: 0, failed: 0, reason: 'no selection' }
    let repos = []
    try {
      const result = config.gitlab.selection.type === 'group'
        ? await gitlab.discover({ group: config.gitlab.selection.path })
        : await gitlab.discover({ repos: config.gitlab.selection.repos })
      repos = result.repos.map((r) => ({ name: r.name, url: r.sshUrl || r.httpUrl }))
    } catch (err) {
      logger?.warn(`sync: discovery failed: ${err.message}`)
      if (manual) throw err
      return { synced: 0, failed: 0, reason: err.code ?? 'discovery failed' }
    }

    pruneStale(repos)

    let synced = 0
    let failed = 0
    for (const repo of repos) {
      if (only && repo.name !== only) continue
      // Manual sync (button / branch change) overrides backoff — the user
      // asked for it now; only the poll timer respects the backoff window.
      if (!manual && !dueForSync(repo.name)) continue
      // One hostile repo (bad URL, crashed git) must not take the whole
      // cycle down with it — the rest of the fleet still gets its turn.
      let outcome
      try {
        outcome = await syncMirror(repo.name, repo.url)
      } catch (err) {
        setState(repo.name, { status: 'error', error: String(err?.message ?? err).slice(0, 500) })
        logger?.error(`sync: ${repo.name} crashed its sync attempt: ${err?.message ?? err}`)
        outcome = 'fail'
      }
      if (outcome === 'ok') synced += 1
      else if (outcome === 'fail') failed += 1
    }
    return { synced, failed }
  }

  // Repos that left the selection (moved, renamed, deselected) must not keep
  // branch overrides or states forever. Two-strikes: pruned only when BOTH
  // the current and the previous discovery omit the repo, so one short or
  // flaky listing cannot wipe live overrides. Disk mirrors are left in
  // place — deleting user data on a transient discovery quirk is worse than
  // the leak.
  function pruneStale(repos) {
    const current = new Set(repos.map((r) => r.name))
    if (lastDiscovery) {
      const gone = (name) => !current.has(name) && !lastDiscovery.has(name)
      const pruned = []
      for (const name of [...mirrors.keys()]) {
        if (gone(name)) {
          mirrors.delete(name)
          pruned.push(name)
        }
      }
      for (const name of Object.keys(config.mirrors ?? {})) {
        if (gone(name)) {
          delete config.mirrors[name]
          pruned.push(name)
        }
      }
      if (pruned.length > 0) {
        save()
        logger?.info(`sync: pruned deselected repos: ${pruned.join(', ')}`)
      }
    }
    lastDiscovery = current
  }

  function enqueue(work) {
    const run = queue.then(work)
    // Failures must not poison the chain for the next cycle — but they are
    // logged, never swallowed silently (the poll path has no HTTP caller).
    queue = run.catch((err) => {
      logger?.warn(`sync: cycle failed: ${err?.message ?? err}`)
    })
    return run
  }

  const pollIntervalMinutes = () => Math.max(1, Math.round(Number(config.pollIntervalMinutes) || 15))

  return {
    states() {
      const out = {}
      for (const [name, state] of mirrors) {
        out[name] = { ...state, branch: config.mirrors?.[name]?.branch ?? null }
      }
      return out
    },
    pollIntervalMinutes,
    // Per-repo branch override (§7.1): null resets to the repo's default.
    // The kick keeps `lastRevision` truthful: what's recorded must track the
    // configured branch immediately, not one poll later.
    setBranch(name, branch) {
      if (!mirrors.has(name) && !lastDiscovery?.has(name)) {
        const err = new Error(`unknown mirror: ${name} (sync first)`)
        err.statusCode = 400
        throw err
      }
      config.mirrors = config.mirrors ?? {}
      config.mirrors[name] = { ...(config.mirrors[name] ?? {}), branch }
      if (!config.mirrors[name].branch) {
        delete config.mirrors[name].branch
        if (Object.keys(config.mirrors[name]).length === 0) delete config.mirrors[name]
      }
      save()
      enqueue(() => runCycle({ manual: true, only: name })).catch(() => {})
      logger?.info(`sync: branch override for ${name}: ${branch ?? 'default'}`)
      return { name, branch: branch ?? null }
    },
    branchOf: (name) => config.mirrors?.[name]?.branch ?? null,
    syncNow: (name) => enqueue(() => runCycle({ manual: true, only: name })),
    syncAll: () => enqueue(() => runCycle({ manual: true })),
    // What the poll timer runs: same cycle, but respects backoff windows.
    pollCycle: () => enqueue(() => runCycle()),
    mirrorPathOf: mirrorPath,
    start() {
      if (started) return
      started = true
      // Run one cycle at startup (staggered so a fleet page load sees life),
      // then on the poll interval.
      enqueue(() => runCycle()).catch(() => {})
      timer = setInterval(() => {
        enqueue(() => runCycle()).catch(() => {})
      }, pollIntervalMinutes() * 60 * 1000)
      timer.unref()
      logger?.info(`sync: polling every ${pollIntervalMinutes()}m`)
    },
    async stop() {
      if (timer) clearInterval(timer)
      started = false
      // In-flight git processes own files under ~/.baize/repos/ and hold the
      // queue open; kill their whole process group so shutdown is immediate.
      // A killed clone leaves at most a half-mirror, which the next sync
      // detects and recreates.
      for (const child of children) killTree(child)
      await queue.catch(() => {})
    },
  }
}
