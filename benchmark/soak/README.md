# CBM WAL/daemon soak (issue #15, PRD §17 item 8)

A duration-configurable soak that indexes a fleet of 20 real open-source
repos (mixed languages, `--depth 1` clones) while concurrent query clients
hammer read tools, sampling WAL size, daemon RSS/restarts, and operation
outcomes. Upstream has open issues in exactly this area (#1083: 115 GB WAL
in 4.5 h under concurrent index workers; #581: slow memory leak; #1955 /
#2107: daemon client timeouts/wedges) — the run decides BaiZe's default
indexing concurrency and checkpoint story.

## Run

```sh
# smoke (4 repos, 8 minutes)
node benchmark/soak/soak.mjs --duration 8m --repos 4 \
  --index-concurrency 2 --index-interval 2m --query-interval 500ms --sample-interval 30s \
  --out /tmp/baize-soak-smoke

# the real thing (20 repos, 24 hours)
node benchmark/soak/soak.mjs --duration 24h --out /tmp/baize-soak-24h
```

Flags (defaults in parentheses): `--duration` (10m), `--repos` (20, max =
fleet size), `--index-concurrency` (4) — parallel `index_repository` calls
per round, `--index-interval` (10m) — pause between full-fleet index rounds,
`--query-clients` (3), `--query-interval` (1s, per client), `--sample-interval`
(60s), `--out` (`/tmp/baize-soak-<ts>`), `--fleet-dir` (`<out>/fleet`, cached
across runs so re-runs skip cloning).

Everything lands under `--out`: `fleet/` (clones), `cache/` (CBM's
`CBM_CACHE_DIR` — never the user's `~/.baize/index/`), `samples.jsonl` (one
row per sample), `events.log` (every log line), `report.json` (final
summary). Ctrl-C / SIGTERM drains the load, tears CBM down, and still writes
the report; a repo that never completes a single index exits non-zero.

## Load model

Close to how baize actually drives CBM:

- **Index rounds**: each round appends a comment line to one repo's source
  file and commits it (a real incremental re-index), then re-indexes every
  repo in the fleet with `--index-concurrency` workers in parallel. The
  unmutated repos exercise the unchanged-revision re-index path too — both
  are write load on CBM's SQLite WAL.
- **Query clients**: N clients loop a random read tool (`search_code`,
  `get_architecture`, `query_graph`, `search_graph`) against a random
  project every `--query-interval`.
- **Sampler**: WAL bytes (total + largest single file), cache dir size,
  daemon PID/RSS, op counters, query P95 per window. Daemon restarts are
  detected by PID change; the daemon is matched by the exact binary path
  this run spawned plus `--cbm-daemon-internal` — the user's own
  `codebase-memory-mcp` instances are never matched or touched.

## Results

TBD — the 24h run's numbers land here (`report.json` summary + the go/no-go
conclusions for indexing concurrency and WAL bounding), and PRD §17 item 8 /
§18 get the decision note.
