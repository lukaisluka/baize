/**
 * Benchmark dataset format (#17, PRD §14): questions with human-reviewed
 * expected answers/evidence and a labeled relevant-repo set per question —
 * the recall denominator. Load + validate + the text-level helpers the
 * runner and report share (citation extraction, CBM index-name mapping).
 *
 * Format (JSON): see benchmark/README.md. Structural invariants enforced
 * here: unique [a-z0-9-] ids, PRD §14 category vocabulary, non-empty
 * questions, non-empty relevantRepos, expected {answer, evidence, reviewed}.
 */

// PRD §14's ten question families, in spec order.
export const CATEGORIES = [
  'code-location',
  'caller-callee',
  'cross-repo-flow',
  'event-tracing',
  'architecture',
  'dependency-inventory',
  'change-impact',
  'business-logic',
  'ambiguous-debugging',
  'code-inventory',
]

export class DatasetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DatasetError'
  }
}

/** Parses + validates. Every violation is collected, not just the first —
 * a dataset author wants the full list per pass. */
export function loadDataset(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new DatasetError(`dataset is not valid JSON: ${err.message}`)
  }
  const errors = []
  const root = parsed
  if (!root || typeof root !== 'object') errors.push('root must be an object')
  const name = root?.name
  if (typeof name !== 'string' || !name.trim()) errors.push('name must be a non-empty string')
  const questions = root?.questions
  if (!Array.isArray(questions) || questions.length === 0) errors.push('questions must be a non-empty array')
  const seen = new Set()
  const cleaned = []
  if (Array.isArray(questions)) {
    questions.forEach((item, i) => {
      const at = `questions[${i}]`
      if (!item || typeof item !== 'object') {
        errors.push(`${at}: must be an object`)
        return
      }
      if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.id)) {
        errors.push(`${at}: id must match [a-z0-9-] (got ${JSON.stringify(item.id)})`)
        return
      }
      if (seen.has(item.id)) errors.push(`${at}: duplicate id "${item.id}"`)
      seen.add(item.id)
      if (!CATEGORIES.includes(item.category)) {
        errors.push(`${at} (${item.id}): category must be one of [${CATEGORIES.join(', ')}] (got ${JSON.stringify(item.category)})`)
      }
      if (typeof item.question !== 'string' || !item.question.trim()) {
        errors.push(`${at} (${item.id}): question must be a non-empty string`)
      }
      const relevant = item.relevantRepos
      if (!Array.isArray(relevant) || relevant.length === 0 || relevant.some((r) => typeof r !== 'string' || !r.trim())) {
        errors.push(`${at} (${item.id}): relevantRepos must be a non-empty array of repo names`)
      } else if (new Set(relevant).size !== relevant.length) {
        errors.push(`${at} (${item.id}): relevantRepos contains duplicates`)
      }
      const expected = item.expected
      if (!expected || typeof expected !== 'object') {
        errors.push(`${at} (${item.id}): expected is required (answer/evidence/reviewed)`)
      } else {
        if (typeof expected.answer !== 'string') errors.push(`${at} (${item.id}): expected.answer must be a string`)
        if (!Array.isArray(expected.evidence) || expected.evidence.some((e) => typeof e !== 'string')) {
          errors.push(`${at} (${item.id}): expected.evidence must be an array of strings`)
        }
        if (typeof expected.reviewed !== 'boolean') errors.push(`${at} (${item.id}): expected.reviewed must be boolean`)
      }
      const applicability = item.applicability ?? 'ok'
      if (applicability !== 'ok' && applicability !== 'needs-multi-repo-estate') {
        errors.push(`${at} (${item.id}): applicability must be "ok" or "needs-multi-repo-estate"`)
      }
      cleaned.push({
        id: item.id,
        category: item.category,
        question: item.question,
        expected: {
          answer: expected?.answer ?? '',
          evidence: expected?.evidence ?? [],
          reviewed: expected?.reviewed ?? false,
        },
        relevantRepos: relevant ?? [],
        applicability,
        ...(typeof item.notes === 'string' ? { notes: item.notes } : {}),
      })
    })
  }
  if (errors.length > 0) throw new DatasetError(`invalid dataset:\n  - ${errors.join('\n  - ')}`)
  return {
    name,
    description: typeof root?.description === 'string' ? root.description : '',
    questions: cleaned,
  }
}

/** A citation as the agent contract states it (#10, src/agent-workspace.js):
 * `<project>/<path>:<line>` with an optional `-end` range, the project part
 * being a fleet repo name (which itself contains slashes). The negative
 * lookbehind keeps URL-ish text (`https://x/y.js:8080`, `http://grp/alpha/…`)
 * from matching: a citation's project segment must not be glued to a
 * preceding path/word character. */
const CITATION_PATTERN = /(?<![/\w.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+):(\d+)(?:-(\d+))?/g

/** Extracts citations from an answer, resolving the repo by longest-prefix
 * match against the known fleet names (a name is itself path-shaped).
 * Unknown-project candidates are dropped — they are not fleet citations. */
export function extractCitations(answer, repoNames) {
  const ordered = [...repoNames].sort((a, b) => b.length - a.length)
  const citations = []
  const seen = new Set()
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const fullPath = match[1]
    const repo = ordered.find((name) => fullPath === name || fullPath.startsWith(`${name}/`))
    if (!repo) continue
    const path = fullPath.slice(repo.length + 1)
    if (!path) continue
    const startLine = Number(match[2])
    const endLine = match[3] ? Number(match[3]) : startLine
    if (startLine === 0 || endLine < startLine) continue
    const raw = match[0]
    if (seen.has(raw)) continue
    seen.add(raw)
    citations.push({ repo, path, startLine, endLine, raw })
  }
  return citations
}

/** CBM normalizes a fleet name into an index name by joining the path
 * segments with dashes (observed live: `grp/alpha` indexes as `grp-alpha`).
 * The runner maps tool-call `project` arguments back to fleet names. */
export function cbmIndexName(repoName) {
  return repoName.replaceAll('/', '-')
}

export function fleetNameFromCbm(cbmProject, repoNames) {
  return repoNames.find((name) => cbmIndexName(name) === cbmProject) ?? null
}
