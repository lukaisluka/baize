#!/usr/bin/env node
/**
 * CBM WAL/daemon soak (#15, PRD §17 item 8).
 *
 * Index a fleet of real repos under concurrent query load for a configured
 * duration, sampling WAL size, daemon RSS/restarts, and operation outcomes.
 * Upstream has open issues here (#1083: 115 GB WAL in 4.5 h under concurrent
 * index workers; #581: slow memory leak; #1955/#2107: daemon wedges) — this
 * harness decides BaiZe's default indexing concurrency and checkpoint story.
 *
 *   node benchmark/soak/soak.mjs --duration 10m --repos 4            # smoke
 *   node benchmark/soak/soak.mjs --duration 24h                      # the real thing
 *
 * Load model (kept close to how baize drives CBM):
 * - an index loop mutates ONE repo per round (append a comment line + git
 *   commit — a real incremental re-index), then re-indexes every repo with
 *   --index-concurrency workers in parallel (write pressure);
 * - query clients loop random read tools (search_code, get_architecture,
 *   query_graph, trace_path) across all projects;
 * - a sampler snapshots every --sample-interval: per-file WAL bytes, cache
 *   dir size, daemon PID/RSS (PID change = restart), op counters, query
 *   P50/P95 per window → samples.jsonl; the final report.json summarizes.
 *
 * Everything lands under --out (default /tmp/baize-soak-<ts>): fleet clones
 * are cached under --fleet-dir (default <out>/fleet) and reused across runs.
 * Ctrl-C / SIGTERM stops the load, tears CBM down, and still writes the
 * report. Degenerate states are loud: missing daemon processes, unindexed
 * repos at the end, or a failed mutation abort with a clear error.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CbmSupervisor, resolveCbmBinary } from '../../src/cbm.js'
import { FLEET } from './repos.mjs'

// ── CLI ────────────────────────────────────────────────────────────────────

function parseDuration(raw, flag) {
  const m = /^(\d+)(ms|[smhd])$/.exec(raw ?? '')
  if (!m) throw new Error(`${flag}: expected e.g. 500ms / 45s / 10m / 24h / 2d, got "${raw}"`)
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]]
}

function parseArgs(argv) {
  const opts = {
    duration: '10m',
    repos: FLEET.length,
    'index-concurrency': 4,
    'index-interval': '10m',
    'query-clients': 3,
    'query-interval': '1s',
    'sample-interval': '60s',
    out: join(tmpdir(), `baize-soak-${new Date().toISOString().replace(/[:.]/g, '-')}`),
    'fleet-dir': null, // default <out>/fleet
  }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const key = flag.startsWith('--') ? flag.slice(2) : flag
    if (!(key in opts)) throw new Error(`unknown flag ${flag}`)
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`)
    opts[key] = argv[i + 1]
  }
  const cfg = {
    durationMs: parseDuration(opts.duration, '--duration'),
    repoCount: Number(opts.repos),
    indexConcurrency: Number(opts['index-concurrency']),
    indexIntervalMs: parseDuration(opts['index-interval'], '--index-interval'),
    queryClients: Number(opts['query-clients']),
    queryIntervalMs: parseDuration(opts['query-interval'], '--query-interval'),
    sampleIntervalMs: parseDuration(opts['sample-interval'], '--sample-interval'),
    outDir: opts.out,
    fleetDir: opts['fleet-dir'],
  }
  const positive = ['repoCount', 'indexConcurrency', 'queryClients']
  for (const k of positive) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new Error(`${k} must be a positive integer`)
  }
  if (cfg.repoCount > FLEET.length) {
    throw new Error(`--repos: fleet only has ${FLEET.length} repos`)
  }
  if (cfg.indexConcurrency > cfg.repoCount) cfg.indexConcurrency = cfg.repoCount
  cfg.fleetDir ??= join(cfg.outDir, 'fleet')
  return cfg
}

// ── fleet ──────────────────────────────────────────────────────────────────

function cloneFleet({ fleetDir, repoCount, log }) {
  const fleet = FLEET.slice(0, repoCount)
  mkdirSync(fleetDir, { recursive: true })
  for (const { project, url } of fleet) {
    const dir = join(fleetDir, project)
    if (existsSync(join(dir, '.git'))) {
      log(`fleet: ${project} already cloned`)
    } else {
      rmSync(dir, { recursive: true, force: true })
      log(`fleet: cloning ${url} (depth 1)`)
      execFileSync('git', ['clone', '-q', '--depth', '1', '--', url, dir], { stdio: 'inherit' })
    }
  }
  return fleet.map((r) => ({ ...r, dir: join(fleetDir, r.project) }))
}

/** Deterministically pick a source file of the repo for the round's mutation.
 * Prefer files CBM actually parses so the incremental index has real work. */
function pickMutationTarget(dir, round) {
  const exts = new Set(['.js', '.mjs', '.cjs', '.ts', '.go', '.rs', '.py', '.c', '.h'])
  const found = []
  const walk = (dirIn, depth) => {
    if (depth > 4 || found.length > 64) return
    for (const entry of readdirSync(dirIn, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const p = join(dirIn, entry.name)
      if (entry.isDirectory()) walk(p, depth + 1)
      else if (exts.has(entry.name.slice(entry.name.lastIndexOf('.')))) found.push(p)
    }
  }
  walk(dir, 0)
  if (found.length === 0) throw new Error(`no parseable source file found under ${dir}`)
  return found[round % found.length]
}

const COMMENT_SYNTAX = {
  '.js': '//', '.mjs': '//', '.cjs': '//', '.ts': '//', '.go': '//', '.rs': '//',
  '.py': '#', '.c': '//', '.h': '//',
}

function mutateOneRepo(repos, round) {
  const repo = repos[(round - 1) % repos.length]
  const target = pickMutationTarget(repo.dir, round)
  const ext = target.slice(target.lastIndexOf('.'))
  const marker = `\n${COMMENT_SYNTAX[ext] ?? '//'} baize soak round ${round} ${new Date().toISOString()}\n`
  appendFileSync(target, marker)
  execFileSync(
    'git',
    ['-C', repo.dir, '-c', 'user.email=soak@baize', '-c', 'user.name=baize-soak', 'commit', '-qam', `soak round ${round}`],
  )
  return { project: repo.project, file: target }
}

// ── process / disk sampling ────────────────────────────────────────────────

/** Snapshot OUR CBM processes only: matched by the exact binary path this
 * run spawned (node_modules/...), never by bare process name — the host may
 * run the user's own codebase-memory-mcp instances that must not be touched
 * or counted. Daemon: `--cbm-daemon-internal`; stdio child: `--ui=false`. */
function snapshotProcs(binaryPath) {
  const res = spawnSync('ps', ['-eo', 'pid=,rss=,args='], { encoding: 'utf8' })
  if (res.error || res.status !== 0) throw new Error(`ps failed: ${res.error ?? res.stderr}`)
  const out = { daemonPid: null, daemonRssKb: null, childPid: null, childRssKb: null }
  for (const line of res.stdout.split('\n')) {
    if (!line.includes(binaryPath)) continue
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const [, pid, rss, args] = m
    if (args.includes('--cbm-daemon-internal')) {
      out.daemonPid = Number(pid)
      out.daemonRssKb = Number(rss)
    } else if (args.includes('--ui=false')) {
      out.childPid = Number(pid)
      out.childRssKb = Number(rss)
    }
  }
  return out
}

/** Walk the CBM cache dir and total db / -wal / -shm bytes. */
function snapshotCache(cacheDir) {
  const out = { dbBytes: 0, walBytes: 0, walMaxBytes: 0, shmBytes: 0, cacheBytes: 0 }
  if (!existsSync(cacheDir)) return out
  const walk = (dirIn) => {
    for (const entry of readdirSync(dirIn, { withFileTypes: true })) {
      const p = join(dirIn, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      const size = statSync(p).size
      out.cacheBytes += size
      if (p.endsWith('.db')) out.dbBytes += size
      else if (p.endsWith('-wal')) {
        out.walBytes += size
        out.walMaxBytes = Math.max(out.walMaxBytes, size)
      } else if (p.endsWith('-shm')) out.shmBytes += size
    }
  }
  walk(cacheDir)
  return out
}

// ── metrics ────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

const QUERY_TOOLS = [
  (project) => ({ name: 'search_code', args: { project, pattern: 'test', limit: 5 } }),
  (project) => ({ name: 'get_architecture', args: { project, aspects: ['overview'] } }),
  (project) => ({ name: 'query_graph', args: { project, format: 'json', query: 'MATCH (f:Function) RETURN f.name LIMIT 5' } }),
  (project) => ({ name: 'search_graph', args: { project, query: 'config', limit: 5 } }),
]

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  mkdirSync(cfg.outDir, { recursive: true })
  const samplesFile = join(cfg.outDir, 'samples.jsonl')
  const eventsFile = join(cfg.outDir, 'events.log')
  const log = (m) => {
    const line = `${new Date().toISOString()} ${m}`
    console.error(line)
    appendFileSync(eventsFile, `${line}\n`)
  }
  const call = (tool, args, timeoutMs = 600_000) => cbm.call(tool, args, { timeoutMs })

  const fleet = cloneFleet({ fleetDir: cfg.fleetDir, repoCount: cfg.repoCount, log })
  const cacheDir = join(cfg.outDir, 'cache')
  const cbm = new CbmSupervisor({ cacheDir, logger: { info: () => {}, warn: (m) => log(`cbm-warn: ${m}`), error: (m) => log(`cbm-err: ${m}`) } })

  const ctx = {
    stopped: false,
    t0: Date.now(),
    deadline: Date.now() + cfg.durationMs,
    fleet,
    call,
    samplesFile,
    log,
    perRepo: new Map(fleet.map((r) => [r.project, { indexOk: 0, indexErr: 0, lastNodes: null }])),
    m: {
      indexOk: 0, indexErr: 0, queryOk: 0, queryErr: 0,
      indexMs: [], queryMs: [],           // rolling per sample window
      indexMsAll: [], queryMsAll: [],     // full-run for the report
      daemonRestarts: 0,
    },
    lastDaemonPid: null,
  }

  const stop = (signal) => {
    if (ctx.stopped) return
    ctx.stopped = true
    log(`received ${signal} — draining`)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const sleepUnlessStopped = async (ms, step = 250) => {
    const until = Date.now() + ms
    while (!ctx.stopped && Date.now() < Math.min(until, ctx.deadline)) {
      await new Promise((r) => setTimeout(r, Math.min(step, Math.max(0, until - Date.now()))))
    }
  }

  // Load: index rounds (mutate one repo, then re-index the fleet with
  // bounded concurrency) + query clients + sampler.
  async function indexLoop() {
    let round = 0
    while (!ctx.stopped && Date.now() < ctx.deadline) {
      round += 1
      let mutated
      try {
        mutated = mutateOneRepo(fleet, round)
      } catch (err) {
        log(`FATAL: mutation round ${round} failed: ${err.message}`)
        stop('mutation-failure')
        return
      }
      log(`round ${round}: mutated ${mutated.project} (${basename(mutated.file)}); indexing ${fleet.length} repos with concurrency ${cfg.indexConcurrency}`)
      let cursor = 0
      await Promise.all(
        Array.from({ length: cfg.indexConcurrency }, async () => {
          while (!ctx.stopped) {
            const i = cursor++
            if (i >= fleet.length) return
            const repo = fleet[i]
            const t0 = performance.now()
            try {
              const r = await call('index_repository', { repo_path: repo.dir, name: repo.project })
              ctx.m.indexOk += 1
              ctx.m.indexMs.push(performance.now() - t0)
              ctx.m.indexMsAll.push(performance.now() - t0)
              ctx.perRepo.get(repo.project).indexOk += 1
              ctx.perRepo.get(repo.project).lastNodes = r?.nodes ?? null
            } catch (err) {
              ctx.m.indexErr += 1
              ctx.perRepo.get(repo.project).indexErr += 1
              log(`index ${repo.project} failed (round ${round}): ${err.message}`)
            }
          }
        }),
      )
      await sleepUnlessStopped(cfg.indexIntervalMs)
    }
  }

  async function queryClient() {
    while (!ctx.stopped && Date.now() < ctx.deadline) {
      // Only repos that have completed an index at least once — querying a
      // repo mid-first-index reports "not found or not indexed", which would
      // pollute the error counter with cold-start noise instead of soak
      // signal.
      const indexed = fleet.filter((r) => ctx.perRepo.get(r.project).indexOk > 0)
      if (indexed.length === 0) {
        await sleepUnlessStopped(2000)
        continue
      }
      const repo = indexed[Math.floor(Math.random() * indexed.length)]
      const make = QUERY_TOOLS[Math.floor(Math.random() * QUERY_TOOLS.length)]
      const { name, args } = make(repo.project)
      const t0 = performance.now()
      try {
        await call(name, args, 120_000)
        ctx.m.queryOk += 1
      } catch (err) {
        ctx.m.queryErr += 1
        log(`query ${name} on ${repo.project} failed: ${String(err.message).slice(0, 200)}`)
      }
      const ms = performance.now() - t0
      ctx.m.queryMs.push(ms)
      ctx.m.queryMsAll.push(ms)
      await sleepUnlessStopped(cfg.queryIntervalMs)
    }
  }

  function sampleOnce() {
    const cache = snapshotCache(cacheDir)
    const binaryPath = resolveCbmBinary()
    const procs = snapshotProcs(binaryPath)
    if (procs.daemonPid !== null && ctx.lastDaemonPid !== null && procs.daemonPid !== ctx.lastDaemonPid) {
      ctx.m.daemonRestarts += 1
      log(`DAEMON RESTART: pid ${ctx.lastDaemonPid} -> ${procs.daemonPid}`)
    }
    if (procs.daemonPid !== null) ctx.lastDaemonPid = procs.daemonPid
    const p95 = percentile([...ctx.m.queryMs].sort((a, b) => a - b), 95)
    const row = {
      t: new Date().toISOString(),
      elapsedMs: Date.now() - ctx.t0,
      ...cache,
      ...procs,
      indexOk: ctx.m.indexOk, indexErr: ctx.m.indexErr,
      queryOk: ctx.m.queryOk, queryErr: ctx.m.queryErr,
      queryP95WindowMs: p95 === null ? null : Math.round(p95),
    }
    appendFileSync(samplesFile, `${JSON.stringify(row)}\n`)
    ctx.m.indexMs = []
    ctx.m.queryMs = []
    log(
      `sample: wal=${(cache.walBytes / 1e6).toFixed(1)}MB max=${(cache.walMaxBytes / 1e6).toFixed(1)}MB ` +
        `cache=${(cache.cacheBytes / 1e6).toFixed(1)}MB daemon=${procs.daemonPid ?? 'GONE'}@${procs.daemonRssKb ?? '?'}KB ` +
        `idx=${ctx.m.indexOk}/${ctx.m.indexErr} q=${ctx.m.queryOk}/${ctx.m.queryErr}`,
    )
  }

  let samplerTimer = null
  const sampler = () => {
    try {
      sampleOnce()
    } catch (err) {
      log(`FATAL: sampler failed: ${err.message}`)
      stop('sampler-failure')
      return
    }
    if (!ctx.stopped) samplerTimer = setTimeout(sampler, cfg.sampleIntervalMs)
  }

  let report = null
  try {
    log(`soak start: ${cfg.repoCount} repos, duration=${Math.round(cfg.durationMs / 60000)}min, indexConcurrency=${cfg.indexConcurrency}, queryClients=${cfg.queryClients}, out=${cfg.outDir}`)
    samplerTimer = setTimeout(sampler, cfg.sampleIntervalMs)
    await Promise.all([indexLoop(), ...Array.from({ length: cfg.queryClients }, () => queryClient())])
  } finally {
    if (samplerTimer) clearTimeout(samplerTimer)
    if (!ctx.stopped) stop('deadline')
    try {
      sampleOnce() // final sample
    } catch { /* already logged its own failure */ }
    try {
      await cbm.stop()
    } catch (err) {
      log(`cbm stop failed: ${err.message}`)
    }
    report = buildReport(cfg, ctx, fleet)
    writeFileSync(join(cfg.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    log(`report written: ${join(cfg.outDir, 'report.json')}`)
    log(
      `summary: indexOk=${report.index.ok} indexErr=${report.index.err} queryOk=${report.query.ok} queryErr=${report.query.err} ` +
        `maxWalMB=${(report.wal.maxTotalBytes / 1e6).toFixed(1)} daemonRestarts=${report.daemon.restarts}`,
    )
    // The unindexed tail is a loud failure, not a footnote: a repo that never
    // completed a single index round makes every other number meaningless.
    const neverIndexed = report.repos.filter((r) => r.indexOk === 0)
    if (neverIndexed.length > 0) {
      log(`FATAL: ${neverIndexed.length} repo(s) never completed an index: ${neverIndexed.map((r) => r.project).join(', ')}`)
      process.exitCode = 1
    }
  }
}

function buildReport(cfg, ctx, fleet) {
  const samples = existsSync(ctx.samplesFile)
    ? readFileSync(ctx.samplesFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const maxOf = (k) => samples.reduce((m, s) => Math.max(m, s[k] ?? 0), 0)
  const daemonRss = samples.filter((s) => s.daemonRssKb !== null).map((s) => s.daemonRssKb)
  return {
    config: {
      durationMs: cfg.durationMs,
      actualMs: Date.now() - ctx.t0,
      repoCount: cfg.repoCount,
      indexConcurrency: cfg.indexConcurrency,
      indexIntervalMs: cfg.indexIntervalMs,
      queryClients: cfg.queryClients,
      sampleIntervalMs: cfg.sampleIntervalMs,
      cbmBinary: basename(resolveCbmBinary()),
    },
    sampleCount: samples.length,
    wal: {
      maxTotalBytes: maxOf('walBytes'),
      maxSingleBytes: maxOf('walMaxBytes'),
      finalTotalBytes: samples.at(-1)?.walBytes ?? 0,
    },
    cache: {
      maxBytes: maxOf('cacheBytes'),
      finalBytes: samples.at(-1)?.cacheBytes ?? 0,
    },
    daemon: {
      restarts: ctx.m.daemonRestarts,
      // first/mid/last shows the RSS trend — the #581 slow-leak signal.
      rssKbFirst: daemonRss[0] ?? null,
      rssKbMid: daemonRss[Math.floor(daemonRss.length / 2)] ?? null,
      rssKbLast: daemonRss.at(-1) ?? null,
      rssKbMax: daemonRss.length ? Math.max(...daemonRss) : null,
      missingSamples: samples.filter((s) => s.daemonPid === null).length,
    },
    index: {
      ok: ctx.m.indexOk,
      err: ctx.m.indexErr,
      p50Ms: percentile([...ctx.m.indexMsAll].sort((a, b) => a - b), 50),
      p95Ms: percentile([...ctx.m.indexMsAll].sort((a, b) => a - b), 95),
    },
    query: {
      ok: ctx.m.queryOk,
      err: ctx.m.queryErr,
      p50Ms: percentile([...ctx.m.queryMsAll].sort((a, b) => a - b), 50),
      p95Ms: percentile([...ctx.m.queryMsAll].sort((a, b) => a - b), 95),
    },
    repos: fleet.map((r) => {
      const st = ctx.perRepo.get(r.project)
      return { project: r.project, indexOk: st.indexOk, indexErr: st.indexErr, lastNodes: st.lastNodes }
    }),
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`)
  process.exit(1)
})
