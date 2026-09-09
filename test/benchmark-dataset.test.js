import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, cbmIndexName, extractCitations, fleetNameFromCbm, loadDataset } from '../src/benchmark/dataset.js'

const here = fileURLToPath(new URL('.', import.meta.url))

test('the seed dataset validates (60 questions, all ten PRD §14 categories)', () => {
  const dataset = loadDataset(readFileSync(`${here}../benchmark/datasets/baize.json`, 'utf8'))
  assert.equal(dataset.questions.length, 60)
  assert.deepEqual(new Set(dataset.questions.map((q) => q.category)), new Set(CATEGORIES))
  // Human review is tracked, and drafts are honest about it.
  assert.ok(dataset.questions.every((q) => typeof q.expected.reviewed === 'boolean'))
  assert.ok(dataset.questions.some((q) => !q.expected.reviewed))
})

test('loadDataset collects every violation, not just the first', () => {
  const raw = JSON.stringify({
    name: 'x',
    questions: [
      // A bad id short-circuits its own item (the id is the join key), so
      // field-level violations need a well-formed id to be reported.
      { id: 'UPPER', category: 'code-location', question: 'q?', relevantRepos: ['r'], expected: { answer: '', evidence: [], reviewed: false } },
      { id: 'q1', category: 'nope', question: '', relevantRepos: [], expected: { answer: 1 } },
      { id: 'q1', category: 'code-location', question: 'q?', relevantRepos: ['r'], expected: { answer: '', evidence: [], reviewed: false } },
    ],
  })
  assert.throws(() => loadDataset(raw), (err) => {
    assert.match(err.message, /id must match/)
    assert.match(err.message, /category must be one of/)
    assert.match(err.message, /question must be a non-empty string/)
    assert.match(err.message, /relevantRepos must be a non-empty array/)
    assert.match(err.message, /expected.answer must be a string/)
    assert.match(err.message, /duplicate id "q1"/)
    return err.name === 'DatasetError'
  })
})

test('loadDataset rejects non-JSON and empty question sets', () => {
  assert.throws(() => loadDataset('{nope'), /not valid JSON/)
  assert.throws(() => loadDataset('{"name":"x","questions":[]}'), /non-empty array/)
  assert.throws(
    () => loadDataset(JSON.stringify({ name: 'x', questions: [{ id: 'q1', category: 'code-location', question: 'q?', relevantRepos: ['r', 'r'], expected: { answer: '', evidence: [], reviewed: false } }] })),
    /relevantRepos contains duplicates/,
  )
})

test('extractCitations resolves slash-bearing repo names by longest prefix', () => {
  const answer = 'See `grp/alpha/hello.js:1-3` and grp/alpha/deep/nested.js:42, plus beta/x.js:7-9.'
  const citations = extractCitations(answer, ['grp/alpha', 'beta', 'grp'])
  // `grp/alpha` wins over `grp` for the same prefix; `grp` alone never matches a file-only path.
  assert.deepEqual(
    citations.map((c) => `${c.repo}|${c.path}|${c.startLine}-${c.endLine}`),
    ['grp/alpha|hello.js|1-3', 'grp/alpha|deep/nested.js|42-42', 'beta|x.js|7-9'],
  )
})

test('extractCitations drops unknown projects, bad ranges, and duplicates', () => {
  const answer = 'unknown/repo/x.js:1 also `grp/alpha/hello.js:5-3` and grp/alpha/hello.js:1 and grp/alpha/hello.js:1.'
  const citations = extractCitations(answer, ['grp/alpha'])
  // 5-3 inverted range dropped; the duplicate :1 collapsed; unknown repo ignored.
  assert.deepEqual(citations.map((c) => c.raw), ['grp/alpha/hello.js:1'])
})

test('extractCitations ignores URL-ish text (ports are not line numbers)', () => {
  const answer = 'docs at https://x/y.js:8080 and http://grp/alpha/README.md:1 — but see grp/alpha/hello.js:7 and (`grp/alpha/bye.js:2`).'
  const citations = extractCitations(answer, ['x', 'grp/alpha'])
  // A citation's project segment must not be glued onto a URL path; the
  // bare and parenthesized citations still count.
  assert.deepEqual(citations.map((c) => c.raw), ['grp/alpha/hello.js:7', 'grp/alpha/bye.js:2'])
})

test('CBM index names map round-trip to fleet names', () => {
  assert.equal(cbmIndexName('grp/alpha'), 'grp-alpha')
  assert.equal(fleetNameFromCbm('grp-alpha', ['grp/alpha', 'beta']), 'grp/alpha')
  assert.equal(fleetNameFromCbm('grp/alpha', ['grp/alpha']), null) // CBM never sees slashes
})
