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
summary). A first Ctrl-C / SIGTERM drains the load, tears CBM down, and
still writes the report; a SECOND user signal force-exits immediately and
abandons the report (internal FATAL paths don't count as signals — a FATAL
followed by one Ctrl-C still produces the report). A repo that never
completes a single index exits non-zero.

## Load model

Close to how baize actually drives CBM:

- **Index rounds**: each round appends a comment line to one repo's source
  file and commits it (a real incremental re-index), then re-indexes every
  repo in the fleet with `--index-concurrency` workers in parallel. The
  unmutated repos exercise the unchanged-revision re-index path too — both
  are write load on CBM's store.
- **Query clients**: N clients loop a random read tool (`search_code`,
  `get_architecture`, `query_graph`, `search_graph`) against a random
  already-indexed project every `--query-interval`.
- **Sampler**: every `--sample-interval` — store bytes (`.db` total,
  `.stage.*` scratch total+max, `-wal`/`-shm`), cache dir size, daemon
  PID/RSS, stdio-child PID/RSS, index-worker count/RSS, op counters, index
  and query P95 per window.

## What is measured, exactly

- **Write amplification**: CBM 0.10.8 commits via stage-and-rename —
  `.db.stage.*` scratch files replace the `.db` on commit. SQLite WAL files
  are not the product here (measured: none appear even mid-indexing), so
  the growth signals are the `stage` totals (transient write traffic),
  per-round `db` deltas (retained growth), and total `cache` size. The WAL
  counters stay in the report for future CBM versions, and a run with
  indexes but zero WAL carries an explicit note saying so — "measured
  zero" must never be silently read as "no growth".
- **Process attribution is exact, not name-based** (binary-path matching
  was proven to claim other runs' daemons on a shared checkout): the stdio
  child is OUR direct child (ppid == the soak process) running `--ui=false`;
  the daemon is the child's direct child with `--cbm-daemon-internal`;
  index workers carry `--response-out` pointing into this run's cache dir.
  Anything else is counted as unattributed and never adopted — the report
  surfaces `unattributed.maxCount`; a healthy run reads 0. Scope caveat: the
  counter only sees processes carrying THIS checkout's binary path — a
  foreign CBM running from a different path (the packaged desktop sidecar,
  `~/.local/bin`) is neither attributable nor counted, so "0" means "no
  same-binary foreign activity", not "no CBM activity at all". Caveat: worker
  attribution matches the cache-dir string as written, so passing an
  `--out` whose *realpath* differs from its written path (a custom symlinked
  parent) can mis-attribute this run's workers as unattributed — the
  default `tmpdir()` and plain `/tmp` paths are verified safe. Sampling
  limits to know: a daemon spawned by an earlier (since-restarted) child
  drops out of the ppid chain and reads as unattributed, and two restarts
  between samples collapse into one PID change. Restart detection is
  PID-change based — a same-PID respawn is invisible to it.
- **Daemon is an account-level singleton bound to ONE cache dir**: while a
  soak runs, no other CBM session on the machine can use a different
  `CBM_CACHE_DIR` (it fails with "active account daemon uses a different
  cache directory"). The harness pre-flights CBM before the run and aborts
  immediately (with the root cause in events.log) if another session holds
  the daemon; conversely, plan for the soak to monopolize the machine's
  CBM for its duration. Teardown's `daemon stop` is refused harmlessly if
  another committed client still uses the daemon.

## Results

TBD — the 24h run's numbers land here (`report.json` summary + the go/no-go
conclusions for indexing concurrency and WAL bounding), and PRD §17 item 8 /
§18 get the decision note.
