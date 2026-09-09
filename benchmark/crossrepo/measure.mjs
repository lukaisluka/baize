#!/usr/bin/env node
/**
 * CBM cross-repo relationship measurement (#14, PRD §17 item 3 / §8.2).
 *
 * Method: write the fixture fleet (fixtures.mjs) into a temp dir, index every
 * repo into a throwaway CBM cache, run `index_repository` in
 * `cross-repo-intelligence` mode from every repo with target_projects=["*"],
 * collect all CROSS_* edges from every project graph, and diff them against
 * ground-truth.json.
 *
 * Outputs per relationship type: hit rate (found links / expected links) and
 * false-positive rate (unexpected edges / total reported edges), plus every
 * miss and every false positive verbatim. Re-run any time CBM is upgraded
 * (PRD §18: every upgrade is re-verified against the Phase 0 checklist):
 *
 *   node benchmark/crossrepo/measure.mjs [--keep]   # --keep: keep the temp cache for inspection
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CbmSupervisor } from '../../src/cbm.js'
import { writeFixtures } from './fixtures.mjs'

const here = new URL('.', import.meta.url)
const groundTruth = JSON.parse(readFileSync(new URL('./ground-truth.json', here), 'utf8'))

const CROSS_TYPES = [
  'CROSS_HTTP_CALLS',
  'CROSS_ASYNC_CALLS',
  'CROSS_CHANNEL',
  'CROSS_GRPC_CALLS',
  'CROSS_GRAPHQL_CALLS',
  'CROSS_TRPC_CALLS',
]
/** Ground-truth "async" covers both topic-style edge types. */
const typesFor = (gtType) => (gtType === 'async' ? ['CROSS_ASYNC_CALLS', 'CROSS_CHANNEL'] : [gtType])

/** A reported edge satisfies a ground-truth relation: same (unordered)
 * project pair, same type family, and — when the relation names a concrete
 * route/topic — the same detail key. Without the key check a channel edge
 * and a Kafka edge between the same pair of repos would satisfy each
 * other's relations. */
function edgeMatchesRelation(edge, relation) {
  const pairOk =
    (edge.from === relation.a && edge.to === relation.b) ||
    (edge.from === relation.b && edge.to === relation.a) ||
    (relation.b === '*' && (edge.from === relation.a || edge.to === relation.a))
  if (!pairOk) return false
  if (!typesFor(relation.type).includes(edge.type)) return false
  if (!relation.key) return true
  const detail = edge.detail?.url_path ?? edge.detail?.channel_name ?? ''
  // HTTP url_path may arrive as a full URL (axios full-URL form) — the route
  // identity is the path suffix.
  if (edge.type === 'CROSS_HTTP_CALLS') return detail === relation.key || detail.endsWith(relation.key)
  return detail === relation.key
}

function matchRelation(relation, edges) {
  if (relation.expect === 'link') return edges.some((e) => edgeMatchesRelation(e, relation))
  return !edges.some((e) => edgeMatchesRelation(e, relation))
}

async function main() {
  const keep = process.argv.includes('--keep')
  const verbose = process.argv.includes('--verbose')
  const root = mkdtempSync(join(tmpdir(), 'baize-crossrepo-'))
  const cache = join(root, 'cache')
  const logger = {
    info: (m) => verbose && console.error(m),
    warn: (m) => console.error(`WARN ${m}`),
    error: (m) => console.error(`ERR ${m}`),
  }
  const repos = writeFixtures(join(root, 'fleet'))
  const cbm = new CbmSupervisor({ cacheDir: cache, logger })
  const call = (tool, args) => cbm.call(tool, args, { timeoutMs: 600000 })

  const report = { startedAt: new Date().toISOString(), repos: [], edges: [], typeSummary: {} }
  try {
    for (const { project, dir } of repos) {
      const r = await call('index_repository', { repo_path: dir, name: project })
      console.error(`indexed ${project}: ${r.nodes} nodes, ${r.edges} edges`)
      report.repos.push({ project, nodes: r.nodes, edges: r.edges })
    }
    for (const { project, dir } of repos) {
      const cr = await call('index_repository', { repo_path: dir, name: project, mode: 'cross-repo-intelligence', target_projects: ['*'] })
      console.error(`cross-repo from ${project}: total=${cr.total_cross_edges} http=${cr.cross_http_calls} async=${cr.cross_async_calls} channel=${cr.cross_channel} grpc=${cr.cross_grpc_calls} graphql=${cr.cross_graphql_calls} trpc=${cr.cross_trpc_calls}`)
    }
    // Cross-repo edges are written into both endpoints' graphs (forward in
    // the caller's, reverse in the handler's), each carrying the OTHER side
    // in props.target_project — that is how project attribution is recovered
    // (the far endpoint is a shadow node whose name carries no project). NB:
    // select node NAME, not qualified_name — shadow nodes have no qn and a
    // qn column silently yields zero rows. format:"json" returns rows as
    // arrays keyed by `columns` (props arrives as a JSON string).
    const seen = new Set()
    for (const { project } of repos) {
      const q = await call('query_graph', {
        project,
        format: 'json',
        query: `MATCH (a)-[r:${CROSS_TYPES.join('|')}]->(b) RETURN type(r) AS rel, a.name AS a, b.name AS b, properties(r) AS props LIMIT 500`,
      })
      for (const [rel, fromName, toName, propsRaw] of q.rows ?? []) {
        const props = typeof propsRaw === 'string' ? JSON.parse(propsRaw) : (propsRaw ?? {})
        const other = props.target_project ?? null
        if (!other || other === project) continue
        const edge = {
          type: rel,
          from: project,
          to: other,
          fromFn: fromName,
          toFn: props.target_function ?? null,
          toFile: props.target_file ?? null,
          detail: props,
        }
        const key = `${edge.type}|${[edge.from, edge.to].sort().join('~')}`
        if (seen.has(key)) continue
        seen.add(key)
        report.edges.push(edge)
      }
    }
  } finally {
    await cbm.stop()
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.error(`kept: ${root}`)
  }

  // Diff against ground truth.
  const byType = {}
  const outcomes = []
  for (const relation of groundTruth.relations) {
    const ok = matchRelation(relation, report.edges)
    const key = relation.type
    byType[key] ??= { expected: 0, hit: 0, traps: 0, trapHeld: 0 }
    if (relation.expect === 'link') {
      byType[key].expected += 1
      if (ok) byType[key].hit += 1
    } else {
      byType[key].traps += 1
      if (ok) byType[key].trapHeld += 1
    }
    outcomes.push({ id: relation.id, expect: relation.expect, ok, detail: relation.detail })
  }
  // False positives: reported edges that satisfy no ground-truth link (same
  // strictness as the hit check — pair + type family + detail key).
  const isKnownLink = (e) =>
    groundTruth.relations.some((r) => r.expect === 'link' && edgeMatchesRelation(e, r))
  const falsePositives = report.edges.filter((e) => !isKnownLink(e))

  for (const [type, s] of Object.entries(byType)) {
    report.typeSummary[type] = {
      hitRate: s.expected === 0 ? null : s.hit / s.expected,
      ...s,
      falsePositives: falsePositives.filter((e) => typesFor(type).includes(e.type)).length,
    }
  }
  report.falsePositives = falsePositives
  report.outcomes = outcomes
  report.totalReportedEdges = report.edges.length

  console.log(JSON.stringify(report, null, 2))
}

main()
