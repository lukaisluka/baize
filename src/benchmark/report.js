/**
 * Benchmark report (#17, PRD §15): computes the three metrics from a run's
 * JSONL —
 *
 * - evidence validity: every citation must resolve (file exists in the
 *   repo's worktree and the line range fits the file at the indexed
 *   revision). Claim↔evidence entailment stays human (PRD §15: sampling).
 * - relevant-repo recall: per question |touched ∩ labeled| / |labeled|,
 *   averaged; touched = cited repos ∪ CBM tool-call projects.
 * - useful-answer rate: aggregated from a human reviews file
 *   ({id, rating: "useful"|"not-useful", rater} lines); unreviewed
 *   questions are reported as pending, never guessed.
 *
 * Plus the leakage check: touched repos must all be in the indexed fleet.
 */

import { existsSync, readFileSync } from 'node:fs'
import { loadDataset } from './dataset.js'

/** Loads a run's JSONL; a corrupt trailing line (interrupted write) is
 * skipped with a warning entry, not a crash. */
export function loadRun(runPath) {
  const entries = []
  const skipped = []
  for (const line of readFileSync(runPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      skipped.push(line.slice(0, 60))
    }
  }
  return { entries, skipped }
}

/** Loads human reviews ({id, rating, rater?} JSONL). Unknown ratings are a
 * dataset error — they would silently skew the useful rate. */
export function loadReviews(reviewsPath) {
  if (!reviewsPath || !existsSync(reviewsPath)) return new Map()
  const reviews = new Map()
  for (const line of readFileSync(reviewsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const review = JSON.parse(line)
    if (review.rating !== 'useful' && review.rating !== 'not-useful') {
      throw new Error(`review for ${review.id}: rating must be "useful" or "not-useful" (got ${JSON.stringify(review.rating)})`)
    }
    reviews.set(review.id, review)
  }
  return reviews
}

/** The default citation resolver: checks the file exists in the repo's
 * worktree and the cited line range fits the file. The worktree is at the
 * indexed revision (sync keeps it there), so a resolve at the worktree IS
 * a resolve at the indexed revision. */
export function worktreeResolver(worktreeByRepo) {
  return (citation) => {
    const worktree = worktreeByRepo.get(citation.repo)
    if (!worktree) return { ok: false, reason: `repo "${citation.repo}" not in fleet` }
    let content
    try {
      content = readFileSync(`${worktree}/${citation.path}`, 'utf8')
    } catch {
      return { ok: false, reason: `file not found: ${citation.path}` }
    }
    const lines = content.split('\n').length
    if (citation.endLine > lines) return { ok: false, reason: `line ${citation.endLine} beyond EOF (${lines} lines): ${citation.path}` }
    return { ok: true }
  }
}

/**
 * Computes the report. `resolveCitation(citation) -> {ok, reason?}` is
 * injected so tests need no filesystem; production uses worktreeResolver.
 * `indexedRepos` is the fleet name list at run time (leakage check).
 */
export function computeReport({ entries, dataset, reviews, resolveCitation, indexedRepos }) {
  const byId = new Map(dataset.questions.map((q) => [q.id, q]))
  // A retried question leaves both rows in the JSONL (the timed-out one and
  // the retry) — the LAST row is the truth; earlier rows must not reach the
  // metrics. Map.set keeps first-insertion order, so row order is stable.
  const latest = new Map()
  for (const entry of entries) {
    if (byId.has(entry.id)) latest.set(entry.id, entry)
  }
  const rows = []
  let citationsTotal = 0
  let citationsValid = 0
  const unindexedRepos = new Set()
  const leaked = new Set()

  for (const entry of latest.values()) {
    const question = byId.get(entry.id)
    let entryCites = 0
    let entryValid = 0
    const citationProblems = []
    for (const citation of entry.citations ?? []) {
      citationsTotal += 1
      entryCites += 1
      const verdict = resolveCitation(citation)
      if (verdict.ok) {
        citationsValid += 1
        entryValid += 1
      } else {
        citationProblems.push(`${citation.raw}: ${verdict.reason}`)
      }
    }
    const touched = entry.touchedRepos ?? []
    for (const repo of touched) {
      if (!indexedRepos.includes(repo)) leaked.add(repo)
    }
    for (const repo of question.relevantRepos) {
      if (!indexedRepos.includes(repo)) unindexedRepos.add(repo)
    }
    const recall = question.relevantRepos.length === 0 ? null : question.relevantRepos.filter((r) => touched.includes(r)).length / question.relevantRepos.length
    const review = reviews.get(entry.id)
    rows.push({
      id: entry.id,
      category: entry.category,
      question: question.question,
      stopReason: entry.stopReason,
      error: entry.error ?? null,
      toolCalls: (entry.toolCalls ?? []).length,
      citations: entryCites,
      citationsValid: entryValid,
      citationProblems,
      touchedRepos: touched,
      relevantRepos: question.relevantRepos,
      recall,
      rating: review?.rating ?? null,
      rater: review?.rater ?? null,
      answerChars: (entry.answer ?? '').length,
      elapsedMs: entry.elapsedMs ?? null,
    })
  }

  const recallValues = rows.map((r) => r.recall).filter((r) => r !== null)
  const rated = rows.filter((r) => r.rating !== null)
  const unanswered = rows.filter((r) => (r.answerChars ?? 0) === 0)
  return {
    dataset: dataset.name,
    questions: { total: dataset.questions.length, run: rows.length, missing: dataset.questions.filter((q) => !rows.some((r) => r.id === q.id)).map((q) => q.id) },
    evidenceValidity: { valid: citationsValid, total: citationsTotal, rate: citationsTotal === 0 ? null : citationsValid / citationsTotal },
    repoRecall: { mean: recallValues.length === 0 ? null : recallValues.reduce((a, b) => a + b, 0) / recallValues.length, perQuestion: recallValues.length },
    usefulRate: { useful: rated.filter((r) => r.rating === 'useful').length, rated: rated.length, pending: rows.length - rated.length, rate: rated.length === 0 ? null : rated.filter((r) => r.rating === 'useful').length / rated.length },
    leakage: { leakedRepos: [...leaked], unindexedLabeledRepos: [...unindexedRepos] },
    anomalies: { unanswered: unanswered.map((r) => r.id), errored: rows.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`) },
    rows,
  }
}

const pct = (rate) => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`)

export function toMarkdown(report) {
  const lines = []
  lines.push(`# Benchmark report — ${report.dataset}`)
  lines.push('')
  lines.push(`Questions: ${report.questions.run} run / ${report.questions.total} in dataset` + (report.questions.missing.length > 0 ? ` (missing: ${report.questions.missing.join(', ')})` : ''))
  lines.push('')
  lines.push('| Metric | Value | Detail |')
  lines.push('| --- | --- | --- |')
  lines.push(`| Evidence validity (§15) | ${pct(report.evidenceValidity.rate)} | ${report.evidenceValidity.valid}/${report.evidenceValidity.total} citations resolve at the indexed revisions |`)
  lines.push(`| Relevant-repo recall (§15) | ${pct(report.repoRecall.mean)} | mean over ${report.repoRecall.perQuestion} questions |`)
  lines.push(`| Useful-answer rate (§15) | ${pct(report.usefulRate.rate)} | ${report.usefulRate.useful}/${report.usefulRate.rated} reviewed, ${report.usefulRate.pending} pending human review |`)
  lines.push(`| Unauthorized leakage | ${report.leakage.leakedRepos.length === 0 ? 'none' : report.leakage.leakedRepos.join(', ')} | touched ⊆ indexed fleet |`)
  if (report.leakage.unindexedLabeledRepos.length > 0) {
    lines.push('')
    lines.push(`> labeled relevant repos not in the indexed fleet: ${report.leakage.unindexedLabeledRepos.join(', ')} — these questions cannot reach full recall.`)
  }
  if (report.anomalies.unanswered.length > 0 || report.anomalies.errored.length > 0) {
    lines.push('')
    lines.push(`> anomalies — unanswered: ${report.anomalies.unanswered.join(', ') || 'none'}; errored: ${report.anomalies.errored.join('; ') || 'none'}`)
  }
  lines.push('')
  lines.push('| id | category | tools | cites (valid) | recall | rating | stop |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of report.rows) {
    lines.push(`| ${row.id} | ${row.category} | ${row.toolCalls} | ${row.citations} (${row.citationsValid}) | ${row.recall === null ? 'n/a' : pct(row.recall)} | ${row.rating ?? 'pending'} | ${row.error ? `error` : row.stopReason ?? '—'} |`)
  }
  return lines.join('\n')
}

/** One-shot: paths in, markdown out. */
export function reportFromFiles({ runPath, datasetPath, reviewsPath, worktreeByRepo }) {
  const dataset = loadDataset(readFileSync(datasetPath, 'utf8'))
  const { entries } = loadRun(runPath)
  const reviews = loadReviews(reviewsPath)
  return computeReport({
    entries,
    dataset,
    reviews,
    resolveCitation: worktreeResolver(worktreeByRepo),
    indexedRepos: [...worktreeByRepo.keys()],
  })
}
