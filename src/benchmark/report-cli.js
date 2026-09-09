#!/usr/bin/env node
/**
 * benchmark report CLI (#17): compute the §15 metrics from a run's JSONL.
 *
 *   node src/benchmark/report-cli.js /tmp/baize-run.jsonl \
 *     --dataset benchmark/datasets/baize.json \
 *     --url http://127.0.0.1:8940 \
 *     [--reviews /tmp/baize-reviews.jsonl] \
 *     [--out report.md]
 *
 * --url is REQUIRED: it fetches the live /api/repos snapshot (repo →
 * worktree map + indexed fleet) that evidence validity and the leakage
 * check are computed against. Without it both metrics would read as
 * confident nonsense (0% validity, everything "leaked"), so the CLI
 * refuses rather than emitting that.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { loadDataset } from './dataset.js'
import { computeReport, loadRun, loadReviews, toMarkdown, worktreeResolver } from './report.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  // A flag's value must not be another flag — `--dataset --url` is a usage
  // error, not a dataset path called "--url".
  if (value === undefined || value.startsWith('--')) return index >= 0 ? undefined : fallback
  return value
}

const runPath = process.argv[2]
const datasetPath = arg('--dataset')
const url = arg('--url')
if (!runPath || !datasetPath || !url || runPath.startsWith('--')) {
  console.error('usage: report-cli.js <run.jsonl> --dataset <dataset.json> --url http://127.0.0.1:<port> [--reviews <reviews.jsonl>] [--out <report.md>]')
  process.exit(2)
}

const dataset = loadDataset(readFileSync(datasetPath, 'utf8'))
const { entries, skipped } = loadRun(runPath)
if (skipped.length > 0) console.error(`warning: ${skipped.length} corrupt line(s) skipped (interrupted write?)`)
const reviews = loadReviews(arg('--reviews'))

const response = await fetch(`${url.replace(/\/$/, '')}/api/repos`)
if (!response.ok) {
  console.error(`GET ${url}/api/repos -> HTTP ${response.status}`)
  process.exit(1)
}
const { repos } = await response.json()
const worktreeByRepo = new Map(repos.map((r) => [r.name, r.path]))

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
