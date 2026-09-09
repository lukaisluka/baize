# Benchmark harness (issue #17, PRD §14–15)

Measures answer quality and retrieval on a live baize server.

## Dataset format

JSON, one file per dataset (`benchmark/datasets/*.json`):

```json
{
  "name": "baize-dogfood-v1",
  "description": "…",
  "questions": [
    {
      "id": "q001",
      "category": "code-location",
      "question": "Where is …?",
      "expected": {
        "answer": "human-reviewed expected answer (draft while review pending)",
        "evidence": ["lukaisluka/baize/src/paths.js:8"],
        "reviewed": false
      },
      "relevantRepos": ["lukaisluka/baize"],
      "applicability": "ok"
    }
  ]
}
```

- `id` — unique, `[a-z0-9-]`.
- `category` — one of the ten PRD §14 families: `code-location`,
  `caller-callee`, `cross-repo-flow`, `event-tracing`, `architecture`,
  `dependency-inventory`, `change-impact`, `business-logic`,
  `ambiguous-debugging`, `code-inventory`.
- `expected.reviewed` — the human-review tracker: drafts carry `false`
  until a reviewer confirms answer + evidence.
- `relevantRepos` — the labeled set the recall metric is measured against.
- `applicability: "needs-multi-repo-estate"` — question families that need
  a real multi-repo fleet (cross-repo flow, event tracing); they stay as
  templates until one is indexed.

## Run

Against a running baize whose fleet is indexed (worktrees must still exist
— citations are validated against them):

```sh
node src/benchmark/run-cli.js benchmark/datasets/baize.json \
  --url http://127.0.0.1:8940 --out /tmp/baize-run.jsonl
```

The runner drives the same ACP path as the chat UI. Output is JSONL, one
line per question (answer, tool calls, citations, touched repos, timings),
appended incrementally — re-invocation skips already-recorded ids, so a
long run can be interrupted and resumed. Errored rows (prompt timeouts)
are retried on the next invocation, not skipped; a retried question is
scored by its last row.

The session cwd defaults to the server's agent workspace
(`/api/repos` → `agentWorkspace`): its `AGENTS.md` is what tells the agent
about the fleet and the CBM tools. Override with `--cwd` only for
experiments — with any other cwd the agent lacks the baize half of the
contract. The runner auto-approves the agent's `session/request_permission`
requests (headless runs would otherwise deadlock on the permission
dialog); every grant is recorded on the entry as `permissionsGranted`.

## Report

With human reviews (`{"id": "q001", "rating": "useful"|"not-useful", "rater": "…"}`,
one JSON object per line) — `--url` is **required**: the fleet snapshot it
fetches is what evidence validity and the leakage check are computed
against, and without it both would read as confident nonsense:

```sh
node src/benchmark/report-cli.js /tmp/baize-run.jsonl \
  --dataset benchmark/datasets/baize.json \
  --url http://127.0.0.1:8940 \
  --reviews /tmp/baize-reviews.jsonl \
  --out /tmp/baize-report.md
```

Metrics (PRD §15 methods):

| Metric | Method |
| --- | --- |
| Evidence validity | every citation in every answer must resolve: the file exists in the repo's worktree (kept at the indexed revision by sync) and the cited line range fits the file |
| Relevant-repo recall | per question: \|touched ∩ labeled\| / \|labeled\|, averaged over questions; touched = cited repos ∪ CBM tool-call projects |
| Useful-answer rate | aggregated from the human reviews file only — unreviewed questions are reported as pending, never guessed |
| Leakage | touched repos must all be inside the indexed fleet |

Caveats by design: claim↔evidence entailment stays human (PRD §15
sampling); the useful rubric is two reviewers + tiebreaker, applied
offline via the reviews file.

Scoring notes:

- A row with `error: null` but an empty answer counts as recorded (not
  retried) — it surfaces under `anomalies.unanswered` in the report.
- An errored row contributes a recall of 0 to the mean: a systemic
  timeout drags fleet-wide recall down, which is the intended reading
  (the system failed the question), not a scoring bug.
- The leakage check compares against the *registered* fleet from
  `/api/repos`; a repo still mid-indexing counts as in-fleet.
