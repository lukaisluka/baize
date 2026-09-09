# AGENTS.md

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `lukaisluka/baize`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles plus this repo's sixth role `claimed`
(issue claimed, work in flight; claim comment names the worktree/branch).
Label strings are identical to role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Workflow rules

### Pull requests

All changes land via pull request — never commit directly to `main`.
Open PRs with `gh pr create`; prefer squash-merge so the PR number is
appended to the subject automatically.

### Commit convention

Commit subjects and PR titles follow Conventional Commits in English:

```
<type>(<scope>): <imperative English subject> (#issue) (#pr)
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`,
`build`. Scope is optional and names a repo area. Keep the trailing
issue/PR references — they are the audit trail back to the tracker
(squash-merge appends the PR number automatically). Only the subject line
is constrained; body and footer stay free-form. Not retroactive: history
predating this section is left as-is. Enforcement: PR titles are linted in
CI (`.github/workflows/pr-title.yml`, hand-rolled regex — keep its type
set in sync with this section); commit subjects on branches stay
convention-only, no commitlint/husky.
