import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { computeReport, loadReviews, loadRun, toMarkdown, worktreeResolver } from '../src/benchmark/report.js'
import { loadDataset } from '../src/benchmark/dataset.js'

const dataset = loadDataset(
  JSON.stringify({
    name: 't',
    questions: [
      { id: 'q1', category: 'code-location', question: 'a?', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
      { id: 'q2', category: 'architecture', question: 'b?', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha', 'grp/beta'] },
      { id: 'q3', category: 'code-inventory', question: 'c?', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
    ],
  }),
)

const entry = (id, overrides = {}) => ({
  dataset: 't',
  id,
  answer: '',
  stopReason: 'end_turn',
  error: null,
  elapsedMs: 10,
  toolCalls: [],
  citations: [],
  touchedRepos: [],
  ...overrides,
})

test('evidence validity: citations must resolve inside the worktree at the indexed revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baize-rep-'))
  try {
    const alpha = join(dir, 'alpha')
    const outside = join(dir, 'outside')
    mkdirSync(alpha)
    mkdirSync(outside)
    // Two real lines + trailing newline: :2 is valid, :3 is beyond EOF.
    writeFileSync(join(alpha, 'hello.js'), 'line1\nline2\n')
    writeFileSync(join(outside, 'secret.txt'), 'x\n')
    symlinkSync('../outside/secret.txt', join(alpha, 'link.js'))
    const resolve = worktreeResolver(new Map([['grp/alpha', alpha]]))
    assert.deepEqual(resolve({ repo: 'grp/alpha', path: 'hello.js', startLine: 1, endLine: 2 }), { ok: true })
    assert.match(resolve({ repo: 'grp/alpha', path: 'hello.js', startLine: 1, endLine: 3 }).reason, /beyond EOF \(2 lines\)/)
    assert.match(resolve({ repo: 'grp/alpha', path: 'nope.js', startLine: 1, endLine: 1 }).reason, /file not found/)
    assert.match(resolve({ repo: 'other', path: 'x', startLine: 1, endLine: 1 }).reason, /not in fleet/)
    // Paths come from agent answers: traversal and symlink escapes out of
    // the worktree are not "resolving in the repo".
    assert.match(resolve({ repo: 'grp/alpha', path: '../outside/secret.txt', startLine: 1, endLine: 1 }).reason, /escapes the worktree/)
    assert.match(resolve({ repo: 'grp/alpha', path: 'link.js', startLine: 1, endLine: 1 }).reason, /escapes the worktree/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('computeReport: recall, validity, useful rate, leakage, anomalies', () => {
  const report = computeReport({
    dataset,
    entries: [
      entry('q1', { answer: 'x', citations: [{ repo: 'grp/alpha', path: 'a.js', startLine: 1, endLine: 2, raw: 'grp/alpha/a.js:1-2' }], touchedRepos: ['grp/alpha'] }),
      entry('q2', { answer: '', citations: [], touchedRepos: ['grp/alpha', 'evil/repo'] }),
      // q3 never ran.
    ],
    reviews: new Map([['q1', { id: 'q1', rating: 'useful', rater: 'luka' }]]),
    resolveCitation: () => ({ ok: true }),
    indexedRepos: ['grp/alpha', 'grp/beta'],
  })
  assert.equal(report.evidenceValidity.rate, 1)
  // q1 recall 1, q2 recall 0.5 → mean 0.75.
  assert.equal(report.repoRecall.mean, 0.75)
  assert.deepEqual(report.questions.missing, ['q3'])
  assert.equal(report.usefulRate.rate, 1)
  assert.equal(report.usefulRate.pending, 1, 'q2 is unreviewed, never guessed')
  assert.deepEqual(report.leakage.leakedRepos, ['evil/repo'])
  assert.deepEqual(report.anomalies.unanswered, ['q2'])
  assert.ok(toMarkdown(report).includes('| Relevant-repo recall (§15) | 75.0% |'))
  assert.ok(toMarkdown(report).includes('missing: q3'))
})

test('invalid citations are counted and surfaced per row', () => {
  const report = computeReport({
    dataset,
    entries: [
      entry('q1', { citations: [{ repo: 'grp/alpha', path: 'gone.js', startLine: 1, endLine: 1, raw: 'grp/alpha/gone.js:1' }], touchedRepos: ['grp/alpha'] }),
    ],
    reviews: new Map(),
    resolveCitation: () => ({ ok: false, reason: 'file not found: gone.js' }),
    indexedRepos: ['grp/alpha'],
  })
  assert.equal(report.evidenceValidity.rate, 0)
  assert.deepEqual(report.rows[0].citationProblems, ['grp/alpha/gone.js:1: file not found: gone.js'])
})

test('labeled repos missing from the fleet are flagged, not silently scored', () => {
  const report = computeReport({
    dataset,
    entries: [entry('q2', { touchedRepos: ['grp/alpha'] })],
    reviews: new Map(),
    resolveCitation: () => ({ ok: true }),
    indexedRepos: ['grp/alpha'], // grp/beta labeled but never indexed
  })
  assert.deepEqual(report.leakage.unindexedLabeledRepos, ['grp/beta'])
  assert.equal(report.repoRecall.mean, 0.5)
})

test('a retried question is scored by its last row only', () => {
  const report = computeReport({
    dataset,
    entries: [
      entry('q1', { answer: '', error: 'prompt timed out', touchedRepos: ['evil/repo'] }),
      entry('q1', { answer: 'ok', touchedRepos: ['grp/alpha'], citations: [{ repo: 'grp/alpha', path: 'a.js', startLine: 1, endLine: 1, raw: 'grp/alpha/a.js:1' }] }),
      entry('from-another-dataset'),
    ],
    reviews: new Map(),
    resolveCitation: () => ({ ok: true }),
    indexedRepos: ['grp/alpha'],
  })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].error, null)
  // The timed-out row's touched repo must not leak into the metrics.
  assert.deepEqual(report.leakage.leakedRepos, [])
  assert.equal(report.evidenceValidity.rate, 1)
  // Stale rows from another dataset revision are surfaced, not dropped.
  assert.equal(report.questions.ignoredRows, 1)
  assert.ok(toMarkdown(report).includes('1 run row(s) matched no dataset question'))
})

test('loadReviews rejects unknown ratings — they would silently skew the rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baize-rev-'))
  try {
    const path = join(dir, 'reviews.jsonl')
    writeFileSync(path, '{"id":"q1","rating":"helpful"}\n')
    assert.throws(() => loadReviews(path), /rating must be "useful" or "not-useful"/)
    assert.equal(loadReviews(join(dir, 'absent.jsonl')).size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadRun skips corrupt trailing lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baize-run-'))
  try {
    const path = join(dir, 'run.jsonl')
    writeFileSync(path, '{"id":"q1"}\n{"id":"q2"')
    const { entries, skipped } = loadRun(path)
    assert.equal(entries.length, 1)
    assert.equal(skipped.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
