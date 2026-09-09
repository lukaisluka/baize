# Cross-repo relationship measurement (issue #14, PRD §17 item 3)

Measures what CBM's `cross-repo-intelligence` mode actually delivers, per
relationship type, against a fixture fleet whose cross-repo links are known by
construction. Re-run this after **every** CBM upgrade (PRD §18: upgrades are
re-verified against the Phase 0 checklist):

```sh
node benchmark/crossrepo/measure.mjs [--verbose] [--keep]
```

- `--verbose` — stream CBM's stderr diagnostics (indexing progress, memory budget)
- `--keep` — keep the temp dir (fixture fleet + CBM cache) for inspection

The run writes fixtures into a temp dir, indexes every repo into a throwaway
CBM cache (`CBM_CACHE_DIR` under the temp dir — never the user's
`~/.baize/index/`), runs `index_repository` in `cross-repo-intelligence` mode
from every repo with `target_projects: ["*"]`, collects all `CROSS_*` edges
from every project graph, and diffs them against [`ground-truth.json`](./ground-truth.json).
It prints a JSON report: per-type hit rate, per-type false positives, every
miss, and every reported edge verbatim.

## Results — CBM 0.10.8 (2026-09-09)

| Relationship type | Edge type | Hit rate | Notes |
|---|---|---|---|
| HTTP route (fetch, relative path) | `CROSS_HTTP_CALLS` | 1/1 | ✓ |
| HTTP route (axios full URL) | `CROSS_HTTP_CALLS` | 1/1 | ✓ — `url_path` arrives as the full URL |
| HTTP route (axios instance + baseURL) | `CROSS_HTTP_CALLS` | 0/1 | extractor never emits HTTP_CALLS for instance methods (`ordersApi.post(...)`) |
| HTTP route (inline arrow handler) | `CROSS_HTTP_CALLS` | 0/1 | measured miss — no `HANDLES` edge is emitted for arrow-function handlers, so the route can never be linked |
| Kafka topic (kafkajs) | `CROSS_ASYNC_CALLS` | 0/2 | kafkajs producer/consumer produce **no** ASYNC_CALLS edges at all — extractor gap, not a matcher miss |
| EventEmitter channel (node:events) | `CROSS_CHANNEL` | 1/1 | ✓ — the async transport that works in JS |
| gRPC (proto + @grpc/grpc-js) | `CROSS_GRPC_CALLS` | 0/1 | no gRPC phase exists in upstream `pass_cross_repo.c`; the counter field exists but no matcher runs |
| GraphQL (@apollo/client) | `CROSS_GRAPHQL_CALLS` | 0/1 | same — no GraphQL phase upstream |

Aggregate: 3 of 9 expected links found; **0 false positives** across 3
reported edges; all 3 traps held — but only the string-URL trap is
discriminating: with kafkajs invisible to the extractor (0 async edges in
the whole fleet), the two Kafka traps (`orders.created.v2` near-miss, orphan
consumer) are held **vacuously** — the matcher never had a chance to
conflate them. They become discriminating the day the extractor emits Kafka
edges; the harness already re-tests them on every run.

## Why the misses happen (root causes, verified against upstream source)

1. **HANDLES requires a named handler — measured, not just inferred.** The
   fixture fleet includes one inline-arrow route (`/inline-orders`) and it
   misses, confirming on 0.10.8 what the source says: cross-repo HTTP
   matching finds the target repo's Route node and follows its `HANDLES`
   edge (`pass_cross_repo.c: find_route_handler`), and the extractor only
   emits `HANDLES` when the handler argument is an identifier / member
   expression / string — an inline arrow function matches none of those
   kinds (`extract_calls.c: extract_handler_arg`). Same requirement for
   `LISTENS_ON` (channel listeners). **Real code bases using inline handlers
   will miss more than the named-handler rows of the table show.**
2. **Client-side extraction is form-sensitive.** `fetch` with a relative path
   and `axios.post` with a full URL are extracted; axios instance methods
   (`ordersApi.post`) are not.
3. **kafkajs is invisible to the extractor.** Neither `producer.send` nor
   `consumer.subscribe` produces ASYNC_CALLS or Channel nodes (verified on
   0.10.8). The async story for JS is currently: EventEmitter yes, Kafka no.
4. **gRPC / GraphQL cross-repo passes do not exist upstream.** The count
   fields (`cross_grpc_calls`, `cross_graphql_calls`) exist in the tool
   response but are always 0 — there is no Phase for them in
   `pass_cross_repo.c`. (Single-repo gRPC server-side `HANDLES` from proto
   files does work.)

## Files

- [`fixtures.mjs`](./fixtures.mjs) — writes the 5-repo fleet (3 shop repos
  with real links, 2 noise repos that are traps) and git-inits each
- [`ground-truth.json`](./ground-truth.json) — the 12 relations (9 links,
  3 no-link traps) with `key` = route path / topic name that edge detail
  must equal; notes per relation record upstream constraints
- [`measure.mjs`](./measure.mjs`) — the runner; the JSON report is the
  deliverable, there is no pass/fail gate — but degenerate collection
  (unattributable rows, rows lost against the counters the cross-repo runs
  report, query truncation) aborts loudly instead of printing wrong
  numbers

## Matching semantics

An edge satisfies a link when the **unordered repo pair** matches, the **type
family** matches, and the edge detail (`url_path` / `channel_name`) equals
the relation's `key` (HTTP keys are route paths; when the edge arrives as a
full URL the **parsed pathname** must equal the key exactly — no suffix
matching, so `/orders` cannot match `/api/orders` or a same-suffix path on
another host). The key check exists because two different transports can
run between the same repo pair — kafka `orders.created` and EventEmitter
`order.created` on the same pair — and without it a channel edge would
satisfy a kafka relation. Traps are the inverse: a trap is *held* when no edge
matches its pair + type + key.

Duplicate copies of an edge are deduplicated by identity (type + repo pair +
detail + endpoint functions, all direction-invariant) — the forward copy in
the caller's graph and the reverse copy in the handler's graph collapse to
one, while two distinct edges of the same type between the same pair (e.g.
two routes) stay separate.
