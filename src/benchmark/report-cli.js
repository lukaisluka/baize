#!/usr/bin/env node
/**
 * benchmark report CLI (#17): compute the §15 metrics from a run's JSONL.
 *
 *   node src/benchmark/report-cli.js /tmp/baize-run.jsonl \
 *     --dataset benchmark/datasets/baize.json \
 *     --reviews /tmp/baize-reviews.jsonl \
 *     --url http://127.0.0.1:8940 \
 *     [--out report.md]
 *
 * --url fetches the live /api/repos snapshot (repo -> worktree map for
 * citation validation). Without it, citations cannot be resolved and the
 * evidence-validity metric reports 0 valid — pass --url against a running
 * server whose home still has the run's worktrees.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { loadDataset } from './dataset.js'
import { computeReport, loadRun, loadReviews, toMarkdown, worktreeResolver } from './report.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const runPath = process.argv[2]
const datasetPath = arg('--dataset')
if (!runPath || !datasetPath) {
  console.error('usage: report-cli.js <run.jsonl> --dataset <dataset.json> [--reviews <reviews.jsonl>] [--url http://127.0.0.1:<port>] [--out <report.md>]')
  process.exit(2)
}

const dataset = loadDataset(readFileSync(datasetPath, 'utf8'))
const { entries, skipped } = loadRun(runPath)
if (skipped.length > 0) console.error(`warning: ${skipped.length} corrupt line(s) skipped (interrupted write?)`)
const reviews = loadReviews(arg('--reviews'))

let worktreeByRepo = new Map()
const url = arg('--url')
if (url) {
  const response = await fetch(`${url.replace(/\/$/, '')}/api/repos`)
  if (!response.ok) {
    console.error(`GET ${url}/api/repos -> HTTP ${response.status}`)
    process.exit(1)
  }
  const { repos } = await response.json()
  worktreeByRepo = new Map(repos.map((r) => [r.name, r.path]))
} else {
  console.error('warning: no --url — citations cannot be resolved; evidence validity will read 0 valid')
}

const report = computeReport({
  entries,
  dataset,
  reviews,
  resolveCitation: worktreeResolver(worktreeByRepo),
  indexedRepos: [...worktreeByRepo.keys()],
})
const markdown = toMarkdown(report)
const out = arg('--out')
if (out) {
  writeFileSync(out, markdown)
  console.error(`report written to ${out}`)
} else {
  console.log(markdown)
}
