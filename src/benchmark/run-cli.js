#!/usr/bin/env node
/**
 * benchmark run CLI (#17): execute a dataset against a live baize server.
 *
 *   node src/benchmark/run-cli.js benchmark/datasets/baize.json \
 *     --url http://127.0.0.1:8940 --out /tmp/baize-run.jsonl
 *
 * Resumable: re-invocation skips ids already present in --out.
 */

import { readFileSync } from 'node:fs'
import { loadDataset } from './dataset.js'
import { runDataset } from './run.js'

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const datasetPath = process.argv[2]
if (!datasetPath || arg('--url') === null || arg('--out') === null) {
  console.error('usage: run-cli.js <dataset.json> --url http://127.0.0.1:<port> --out <run.jsonl> [--cwd <dir>] [--timeout-ms <n>]')
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
    timeoutMs: Number(arg('--timeout-ms', 240000)),
    logger: { info: (m) => console.error(m), warn: (m) => console.error(`WARN ${m}`), error: (m) => console.error(`ERR ${m}`) },
  })
  console.error('run complete')
} catch (err) {
  console.error(`run failed: ${err.message}`)
  process.exit(1)
}
