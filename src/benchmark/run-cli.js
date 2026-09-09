#!/usr/bin/env node
/**
 * benchmark run CLI (#17): execute a dataset against a live baize server.
 *
 *   node src/benchmark/run-cli.js benchmark/datasets/baize.json \
 *     --url http://127.0.0.1:8940 --out /tmp/baize-run.jsonl
 *
 * Resumable: re-invocation skips successfully recorded ids and retries
 * errored ones.
 */

import { readFileSync } from 'node:fs'
import { loadDataset } from './dataset.js'
import { runDataset } from './run.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  // A flag with no value (--url as the last arg) must not silently become
  // "undefined" downstream — it is a usage error.
  if (value === undefined || value.startsWith('--')) return index >= 0 ? undefined : fallback
  return value
}

const datasetPath = process.argv[2]
const timeoutMs = Number(arg('--timeout-ms', 240000))
const missing = [
  [!datasetPath || datasetPath.startsWith('--'), '<dataset.json>'],
  [arg('--url') === undefined || arg('--url') === null, '--url <http://127.0.0.1:port>'],
  [arg('--out') === undefined || arg('--out') === null, '--out <run.jsonl>'],
  [arg('--timeout-ms') !== null && !Number.isFinite(timeoutMs), '--timeout-ms <integer>'],
].filter(([bad]) => bad)
if (missing.length > 0) {
  console.error(`usage: run-cli.js <dataset.json> --url http://127.0.0.1:<port> --out <run.jsonl> [--cwd <dir>] [--timeout-ms <n>]
${missing.map(([, what]) => `  missing or invalid: ${what}`).join('\n')}`)
  process.exit(2)
}

const dataset = loadDataset(readFileSync(datasetPath, 'utf8'))
console.error(`dataset "${dataset.name}": ${dataset.questions.length} questions`)

try {
  await runDataset({
    baseUrl: arg('--url'),
    dataset,
    out: arg('--out'),
    cwd: arg('--cwd'),
    timeoutMs,
    logger: { info: (m) => console.error(m), warn: (m) => console.error(`WARN ${m}`), error: (m) => console.error(`ERR ${m}`) },
  })
  console.error('run complete')
} catch (err) {
  console.error(`run failed: ${err.message}`)
  process.exit(1)
}
