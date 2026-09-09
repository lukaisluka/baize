# BaiZe PRD

> Status: Draft
> Product: BaiZe
> Version: 0.2.1
>
> Changelog v0.2.1: folded in 2026-09-09 engine research — OMP identified as Oh My Pi; CBM capabilities verified against source (LSP wording, tool surface, cross-repo maturity, WAL/daemon risks); desktop-shell path changed from Node SEA to plain-Node sidecar.
>
> Changelog v0.2:
> - Positioning split into **Personal form** (single-user local web tool, `npx baize`) and **Enterprise form** (later; 800+ repos, gateway/ACL/audit). Sections marked **[Enterprise]** are out of MVP scope.
> - MVP architecture fixed: single Node.js orchestrator process; web UI derived from Panda's web code; ACP-over-WebSocket for chat plus a BaiZe management API.
> - Fleet pulled into MVP, scoped to GitLab only: PAT for API discovery, system git for clone/fetch, polling + manual sync, bare mirrors, per-repo `needs-auth` handling.
> - ACL in Personal form delegated to the user's own Git credentials.
> - Optional Tauri desktop shell derived from Panda's `src-tauri` (Node SEA sidecar, to be validated).
> - New: Terminology; Phase 0 CBM technical-validation checklist with pass criteria.
> - Success metrics now carry measurement methods; Phase numbering deduplicated (development phases vs scale milestones).
> - Open questions pruned; each remaining one annotated with what it blocks.

## 1. Background

Large engineering organizations typically spread business logic across hundreds of repositories, services, shared libraries, infrastructure repositories, schemas, event definitions, and historical implementations.

Existing coding agents are strong at reasoning over the current workspace, but they lack a reliable organization-wide view of:

- where relevant code exists,
- how code in different repositories is connected,
- which services call or depend on each other,
- what a change may impact,
- how to trace a business flow across repositories,
- how to answer questions using evidence from the actual source code.

BaiZe aims to provide a code understanding layer for AI agents without rebuilding code parsing, graph construction, or model reasoning from scratch.

## 2. Product Vision

**BaiZe enables engineers to ask any question about the codebase as if all repositories formed one coherent software system.**

Example questions:

- Where is funding rate calculated?
- What happens after an order enters the API gateway?
- Which repositories publish or consume Kafka topic `trade.executed`?
- Which services modify user balances after a trade?
- Who calls `RiskService.CheckOrder`?
- What would be impacted if this protobuf field changes?
- Why does this flow exist in this form?
- Which repositories still depend on a deprecated API?
- Trace the full flow from order placement to settlement.

## 3. Product Forms and Positioning

BaiZe evolves through two deployment forms. This split is explicit so that MVP scope is not judged against enterprise requirements.

### 3.1 Personal form (V0.x — the focus of this PRD)

- **Single user, runs on the engineer's own machine**, presented as a **web UI** served locally.
- Started with one command: `npx baize`.
- **Authorization is delegated to the user's own Git credentials** (GitLab PAT for discovery + the user's local git credentials for clone/fetch): BaiZe can see exactly what the user can already see — nothing more, and no separate ACL system is required at this stage.
- Target scale: the repositories a single engineer works across — tens to a few hundred. Scale milestones S1–S2 (see §12).

### 3.2 Enterprise form (later)

Shared, centrally deployed control plane around the same engines: gateway, query routing, ACL beyond SCM-token delegation, audit, multi-user, webhook-driven sync, 800+ repositories (scale milestones S3–S5). Only gaps proven by the Personal form and its scale validation get built.

## 4. Design Principles

1. **Local-first / self-hosted**
   - Source code, indexes, graph data, agent context, logs, and audit records stay on the user's machine (Personal) or inside enterprise infrastructure (Enterprise).

2. **Do not rebuild existing code-intelligence engines**
   - Reuse `codebase-memory-mcp` (CBM) for code parsing, symbol analysis, graph construction, semantic search, call graph, and impact analysis — subject to the Phase 0 validation in §17.

3. **Agent and intelligence engine are separate**
   - OMP is responsible for reasoning and research loops.
   - BaiZe provides organization-wide code context, and (later) routing, security, and orchestration.

4. **Treat all repositories as one software system**
   - Repository boundaries must not prevent cross-service or cross-domain analysis.

5. **Evidence-first answers**
   - AI answers should be grounded in source files, symbols, commits, and graph relationships.

6. **Scale incrementally**
   - Personal form first; enterprise capabilities only where real scale requires them.

## 5. Terminology

| Term | Definition |
| ---- | ---------- |
| **ACP** | Agent Client Protocol — JSON-RPC protocol between client UIs and agents (sessions, prompts, tool calls, permissions). Originated at Zed; TS SDK `@agentclientprotocol/sdk`. |
| **MCP** | Model Context Protocol — tool interface between an agent and tool servers (here: between OMP and CBM). |
| **OMP** | [Oh My Pi](https://github.com/can1357/oh-my-pi) — the reasoning agent runtime BaiZe embeds (MIT): agent loop, tool selection, query decomposition, multi-step investigation, evidence aggregation, answer generation. A hard fork of pi with **native ACP** (`omp acp`) and **built-in MCP support** — the two properties BaiZe's chain requires. TypeScript agent layer over a Rust core. |
| **pi** | The original agent harness ([earendil-works/pi](https://github.com/earendil-works/pi), formerly badlogic/pi-mono), MIT, embeddable via SDK. No native ACP or MCP (community adapters exist), so OMP is the default; pi remains a fallback via adapters. |
| **CBM** | `codebase-memory-mcp` — the open-source code-intelligence engine BaiZe reuses ([DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), MIT, single static binary: pure C with vendored tree-sitter + SQLite). Capabilities per §6.1 and §17. |
| **Zoekt** | Trigram-based code-search engine; optional global recall layer in the Enterprise form only. |
| **Fleet** | BaiZe's repository management: discovery, synchronization, and indexing orchestration. |
| **BaiZe Skills** | Static Agent Skill documents loaded by the agent that encode investigation strategies. They are prompt/configuration assets, **not a runtime call-chain hop**. |

## 6. MVP Architecture (Personal Form)

```text
Browser — BaiZe UI (SPA derived from Panda's web code)
   |  HTTP + WebSocket
   |    - ACP over WebSocket: chat / agent sessions
   |    - BaiZe management API (REST/WS): fleet, config, indexing status
   v
baize CLI — single Node.js process (`npx baize`), binds 127.0.0.1 only
   |-- serves the UI static build
   |-- ACP bridge (WebSocket <-> stdio)
   |-- spawns OMP (ACP over stdio)
   |       `-- MCP (stdio) --> CBM child process
   `-- fleet worker: scheduled poll + manual sync via system git
           `-- ~/.baize/repos/ (bare mirrors) --worktree--> ~/.baize/worktrees/ (checkouts) --> CBM index (~/.baize/index/)
```

### 6.1 Component responsibilities

**BaiZe UI** (derived from Panda's web code, see §6.3)

- Chat interface with source-code citations
- Conversation management
- Repository/file/symbol navigation
- Fleet management pages: repo list, sync status, `needs-auth` state, last indexed commit
- Settings: GitLab URL + PAT, poll interval, per-repo branch overrides
- Indexing progress and error/status reporting
- _Eventual_: architecture/dependency graph visualization, research-progress visualization (not MVP)

**OMP** (Oh My Pi)

- Agent loop, tool selection, query decomposition
- Multi-step investigation and evidence aggregation
- Final answer generation; optional sub-agents
- Runs with the permissions of the launching process (no built-in sandbox) and has install/update telemetry (documented opt-out) — acceptable in the Personal form, to be documented for Enterprise

**CBM (`codebase-memory-mcp`)** — MIT, single static binary (pure C, vendored tree-sitter + SQLite compiled in)

- Repository indexing, tree-sitter parsing (158 vendored grammars), **LSP-grade type resolution reimplemented in-engine** for 9 language families (Go/Rust/Java/TypeScript included, "Good" 75–89% quality tier) — no language-server processes involved
- Full-text / BM25 search (SQLite FTS5); semantic search via **bundled on-device embeddings** (nomic-embed-code, no API key — fits the self-hosted principle)
- Code graph, callers / callees (`trace_path`), change-impact analysis (`detect_changes`)
- MCP tool interface (17 tools as of v0.10.8 — README/docs lag the source; always verify against the pinned version)
- **Cross-repository relationships exist but are immature**: `cross-repo-intelligence` mode writes `CROSS_HTTP_CALLS` / `CROSS_ASYNC_CALLS` / `CROSS_GRPC_CALLS` / etc. edges bidirectionally into both project DBs, with known false positives and missed edges (upstream issues #523, #1459, #953, #706); Kafka-class async-topic matching is partial. Measured in Phase 0 item 3 — per-transport numbers and go/adjust decisions in §8.2.
- Storage: one SQLite DB (WAL mode) per project under `CBM_CACHE_DIR` (BaiZe points it at `~/.baize/index/`); cross-DB queries are blocked, so cross-repo edges are duplicated into both DBs
- A per-account background daemon serves multiple MCP clients; its lifecycle should be owned and supervised by the baize CLI (see §18)
- Distribution: the npm package downloads the static binary from GitHub Releases at postinstall (needs network); for locked-down environments BaiZe pre-bundles or mirrors the binary

**baize CLI (orchestrator)**

- Serves the UI; bridges ACP (WebSocket ↔ stdio)
- Spawns and supervises OMP; injects CBM into the agent's ACP session (`mcpServers` on session/new|load|resume — see §17 item 1 note) and regenerates the workspace `AGENTS.md` (fleet listing + citation rules) per connection
- Runs the fleet worker (§7)
- Exposes the management API to the UI

### 6.2 Distribution and runtime contract

- **npm package**, run via `npx baize` (or global install). Only prerequisites: Node.js and system `git` with working credentials (checked lazily — see §7).
- Binds **127.0.0.1 only**; random or configured local port.
- All state under `~/.baize/`:

```text
~/.baize/
├── config.json      # GitLab URL, PAT (chmod 600), poll interval, branch overrides, agentCommand
├── omp-overlay.yml  # OMP telemetry opt-out, written once by baize (editable)
├── agent/           # working directory for spawned agent processes
├── repos/           # bare mirror clones
├── worktrees/       # linked worktrees at tracked revisions — what CBM indexes
├── index/           # CBM data
└── logs/
```

- First-run **setup wizard** in the web UI (no hand-editing config): GitLab URL + PAT → pick group/repos → repo count + disk estimate → start sync with live indexing progress.
- Foreground process with Ctrl-C to stop (dev-tool style); daemonization is out of scope for V0.1.

### 6.3 UI provenance: derived from Panda

- The UI is **vendored from Panda's web code into the baize repo** — not consumed as an npm dependency. Panda evolves independently; porting upstream fixes is manual until a shared package is justified.
- Reused as-is where possible: Vite SPA skeleton, ACP client layer, chat UI, citation rendering.
- New in BaiZe: all management surfaces (fleet, settings, indexing progress) — Panda has no equivalents.
- Two channels between UI and server: **ACP over WebSocket** (chat/agent sessions, reusing Panda's stdio↔WebSocket bridge pattern) and the **BaiZe management API** (everything else; out of ACP's scope).

### 6.4 Repository layout

Single npm package (no workspace split until a second publishable unit exists):

```text
baize/
├── package.json        # bin: baize
├── src/                # server, orchestrator, fleet worker
├── ui/                 # Panda-derived SPA (vite build -> dist/ui)
└── dist/               # published artifact; npx runs from here
```

### 6.5 Optional desktop shell (Phase 1+, not MVP-critical)

- **Tauri** shell derived from Panda's `desktop/src-tauri`.
- Shell responsibilities only: spawn the baize server as a **sidecar** and load the local UI in the system webview.
- **Sidecar packaging: a plain per-platform Node binary + bundled JS** (the pattern Tauri's docs describe; runtime semantics identical to `npx baize`, `fork`/`spawn` children unaffected). Node SEA is second-choice: still Stability 1.1, and `child_process.fork()` is broken by design in SEA binaries. `bun build --compile` is rejected — runtime divergence from the npm CLI is a support risk.
- The shell must kill the whole **process tree** on quit (Tauri does not kill sidecar children); the server handles SIGTERM by cleaning up its own children.
- Shares 100% of UI and server code with the `npx` form; adds packaging/signing/notarization pipeline cost, so it ships after the `npx` form is proven.

## 7. Repository Management (Fleet — MVP scope)

Fleet is part of the MVP, scoped down to a single-user GitLab deployment. The enterprise fleet surface is in §13.

### 7.1 Configuration surface

- **SCM**: GitLab only — self-hosted instances and gitlab.com. GitHub/Bitbucket/Azure DevOps: [Enterprise].
- **User input**: GitLab base URL, PAT, and a selection: a **group** (traversed recursively) or an explicit repo list.
- **Branch policy**: per-repo branch override; default is the repo's default branch. (Resolves former open question 5.)

### 7.2 Credentials

- **PAT** is used for GitLab API calls (discovery, metadata) only. Stored locally in `~/.baize/config.json` (chmod 600, plaintext acceptable in V0.1). **Hard rule: the PAT must never appear in logs or audit records.** Required scopes: `read_api` — confirmed sufficient (issue #11): discovery uses only the REST v4 API, and clone/fetch never carries the PAT (§7.3), so `read_repository` is not needed.
- Phase 1 deliberately does not harden credential storage further (no keychain integration).

### 7.3 Clone and fetch

- Uses **system git with the user's ambient credentials** (SSH agent / git credential helper). BaiZe does not embed the PAT into remote URLs.
- Assumes the user's git access is already configured. On authentication failure (HTTP 401 or SSH auth error):
  - mark the repo `needs-auth`,
  - back off exponentially (don't retry every poll cycle),
  - surface a clear remediation hint in the UI (check git credentials / token).
- If the PAT itself fails at the GitLab API (401 during discovery), raise a single global prompt in the UI.

### 7.4 Mirror layout

- **Bare mirrors** under `~/.baize/repos/` (no full clones). Each mirror
  materializes a **linked worktree** at the tracked revision under
  `~/.baize/worktrees/` (shared object store — one checkout, not a second
  clone). The worktree is what CBM indexes: CBM reads source files from disk
  and cannot index by git ref, and a bare mirror's only loose files are hook
  samples (verified in #13 — indexing a bare mirror yields zero code
  symbols). Worktrees are updated (or re-materialized, if debris) on every
  successful sync; branch overrides move them too.
- Consequence: "open in local IDE" deep links stay out of scope for V0.1 —
  the worktree is engine-internal and detached, not a user workspace.

### 7.5 Synchronization

- **Scheduled polling** (configurable interval) + **manual "sync now"** per repo and globally.
- Webhooks are **not viable** for a NAT'd local machine and are deferred to the [Enterprise] form.
- Per-repo pipeline:

```text
discover -> clone -> fetch -> detect new revision -> enqueue index job -> incremental CBM index
```

- Requirements: retry with backoff, idempotency, per-repo state, last-indexed-commit tracking, no duplicate indexing jobs.
- Group handling in Phase 1: recursive traversal, pull everything. No special handling for archived repos, size caps, LFS, or submodules beyond the onboarding disk estimate (revisit when the first real incident happens).

## 8. Core Product Capabilities

### 8.1 Code Q&A

Users can ask natural-language questions about any repository visible to their credentials:

- implementation lookup,
- architecture questions,
- cross-repository flow tracing (see §8.2 caveat),
- dependency analysis,
- symbol relationships,
- change impact,
- technology inventory,
- service ownership discovery,
- business-flow investigation.

### 8.2 Cross-Repository Understanding — measured (Phase 0 item 3, CBM 0.10.8)

BaiZe aims to identify relationships that cross repository boundaries, including:

- HTTP calls, gRPC calls, GraphQL,
- protobuf/schema references,
- shared libraries,
- Kafka / message-bus producers and consumers,
- database access, event flows, service dependencies.

**Status: measured 2026-09-09.** `benchmark/crossrepo/` writes a 5-repo fixture fleet whose cross-repo links and traps are known by construction, runs CBM's `cross-repo-intelligence` mode, and diffs the reported edges against ground truth (re-run on every CBM upgrade, §18). Results — hit rate over expected links, false positives over all reported edges:

| Transport | Edge type | Hit | FP | Verdict |
|---|---|---|---|---|
| HTTP route — `fetch` relative path, `axios.post` full URL | `CROSS_HTTP_CALLS` | 2/4 | 0 | **go**, with the constraints below |
| HTTP route — axios instance + baseURL (`ordersApi.post`) | `CROSS_HTTP_CALLS` | 0/1 | 0 | adjust — extractor never emits calls for instance methods |
| HTTP route — inline arrow handler (measured) | `CROSS_HTTP_CALLS` | 0/1 | 0 | adjust — no `HANDLES` edge for arrow-function handlers, so the route can never be linked |
| Kafka topic (kafkajs) | `CROSS_ASYNC_CALLS` | 0/2 | 0 | **adjust** — kafkajs is invisible to the extractor on 0.10.8 (no ASYNC_CALLS at all) |
| EventEmitter channel (node:events) | `CROSS_CHANNEL` | 1/1 | 0 | go |
| gRPC (proto + @grpc/grpc-js) | `CROSS_GRPC_CALLS` | 0/1 | 0 | **adjust** — no gRPC matching pass exists upstream |
| GraphQL (@apollo/client) | `CROSS_GRAPHQL_CALLS` | 0/1 | 0 | **adjust** — no GraphQL matching pass exists upstream |

All three traps held, but only the string-URL trap is discriminating: with
kafkajs invisible to the extractor (zero async edges in the whole fleet),
the two Kafka traps are held vacuously — they become discriminating the day
Kafka extraction exists.

Constraints that define what "HTTP works" means (verified against upstream source, `pass_cross_repo.c` / `extract_calls.c`):

- The server-side handler must be a **named function** (`app.get('/orders', listOrders)`). Matching follows the Route node's `HANDLES` edge, and the extractor emits `HANDLES` only for identifier / member-expression / string handler arguments — inline arrow functions never match (measured: an inline-arrow fixture route misses). Channel listeners (`LISTENS_ON`) have the same requirement. Real code bases using inline handlers will miss more than these fixture numbers show.
- Client-side extraction is form-sensitive: `fetch` with a relative path and `axios.post` with a full URL are extracted; axios instance methods are not.

**Decision**: cross-repo understanding ships as an engine commitment for **HTTP routes and EventEmitter-style channels only**. Kafka, gRPC, and GraphQL cross-repo discovery are not engine commitments — they are covered by the `cross-repo-investigation` skill family and search-augmented investigation (§9) until upstream closes the gap, and §8.4 inherits the same boundary.

### 8.3 Evidence and Citations

Every material answer should include enough evidence to verify it:

- repository, branch/revision where possible,
- file path, line range, symbol,
- related graph edge or dependency.

The UI enforces the converse visibly (issue #10): a settled turn whose answer cites no tool evidence at all — no tool_call block in the turn — renders a trailing "unverified" notice, so an unsupported answer never reads as grounded.

### 8.4 Change Impact Analysis

Given a symbol, file, API, schema, topic, or diff: identify direct and transitive dependents, affected repositories, blast-radius classification, and supporting evidence. Engine-backed impact analysis is bounded by §8.2's measured coverage (HTTP routes and channels; Kafka/gRPC/GraphQL cross-repo edges do not exist today) — other transports rely on the BaiZe Skills and search-augmented investigation of §9.

### 8.5 Architecture Exploration

Users should be able to ask: What are the major services in domain X? Show the dependencies of service Y. Trace business flow Z. Which repositories belong to this subsystem?

Interactive graph rendering in the UI is an **eventual** capability, not MVP.

## 9. BaiZe Skills

BaiZe ships Agent Skills that encode code-research strategies rather than duplicating intelligence engines. Skills are **static documents loaded by the agent** (prompt assets shipped in the npm package), not services in the request path.

Examples:

- `cross-repo-investigation` — tracing a behavior across repositories.
- `impact-analysis` — combining symbol graph, code search, API/schema usage, and repo relationships.
- `architecture-analysis` — inferring system boundaries and producing architecture-level answers.
- `event-flow-analysis` — tracing Kafka/message-bus producer → consumer chains.
- `evidence-validation` — requiring sufficient source evidence before presenting a conclusion.

Per-organization customization of Skills: [Enterprise].

## 10. Non-Goals for V0.1

BaiZe will NOT initially build:

- a new AST parser, LSP implementation, vector database, knowledge-graph engine, code-search engine, or LLM gateway,
- an autonomous coding agent, or a replacement for OMP,
- a Sourcegraph/Sourcebot clone,
- multi-user support or any ACL beyond credential delegation,
- webhook-driven sync, non-GitLab SCM support,
- worktrees / local-IDE deep links,
- hardened credential storage (keychain etc.).

## 11. MVP Deliverables

1. `npx baize` single-command startup on a clean machine with only Node.js + git.
2. Web setup wizard: GitLab URL + PAT + group/repo selection with disk estimate.
3. Fleet sync: polling + manual, per-repo branch config, bare mirrors, `needs-auth` handling.
4. CBM indexing of selected repositories; OMP answers cross-repository questions with source citations in the BaiZe UI.
5. Benchmark run (§15) with answer-quality and performance metrics report.
6. _Optional_: Tauri desktop shell (§6.5).

## 12. Indexing Model and Scale Milestones

Scale milestones (renamed from "Phase 1/2/3" in v0.1 to avoid clashing with §18's development phases):

| Milestone | Scope | Form |
| --------- | ----- | ---- |
| S1 | 20 repos | Personal |
| S2 | 100 repos | Personal |
| S3 | 200 repos | Personal stretch — validate before committing |
| S4 | 500 repos | [Enterprise] |
| S5 | 800+ repos | [Enterprise] |

Measure at each milestone:

- initial indexing throughput, incremental indexing latency,
- DB/index size, CPU, memory, disk I/O,
- query latency, concurrent query behavior.

Sharding strategies ([Enterprise], if required):

- **Repository hash**: `hash(repo_id) % N` — simple but weak for cross-repo locality.
- **Business-domain grouping** (preferred where feasible): keep heavily related repositories (e.g. `trading: gateway, order-service, risk, matching, clearing`) in the same graph shard. This matches CBM's storage model: cross-DB queries are blocked and cross-repo edges are duplicated into both project DBs, so domain-grouped shards lose no edges.

## 13. Enterprise Form [Enterprise] — future

> Everything in this section is out of MVP scope. It is preserved from v0.1 as the direction for the shared/central deployment; build only what Personal-form scale validation proves necessary.

### 13.1 Target architecture

```text
                            BaiZe UI
                               |
                              ACP
                               |
                              OMP
                               |
                              MCP
                               |
                    +----------v----------+
                    |    BaiZe Gateway    |
                    | Auth / ACL          |
                    | Repo Scope          |
                    | Query Routing       |
                    | Fan-out / Merge     |
                    | Audit               |
                    +----------+----------+
                               |
                  +------------+------------+
                  |                         |
                Zoekt               CBM Shards
          Global Recall/Search     Code Understanding
                  |                         |
             800+ repos          selected repo groups
```

Zoekt is optional; introduce only if global full-text search through CBM misses latency or recall targets.

### 13.2 Enterprise fleet

- Multi-SCM discovery: GitHub/GHE, GitLab, Bitbucket, Azure DevOps/TFS, generic Git; org/group discovery, inclusion/exclusion rules, default-branch discovery, archived-repo handling, deleted-repo cleanup.
- Event-driven updates via Git-provider webhooks → fleet controller → fetch → enqueue incremental index. Periodic reconciliation remains the fallback.

### 13.3 Query routing

The gateway exposes a stable MCP surface independent of engine topology. Example logical tools: `search_code`, `search_symbols`, `read_code`, `find_definition`, `find_references`, `get_callers`, `get_callees`, `trace_path`, `impact_analysis`, `get_architecture`, `list_repositories`. OMP should not need to know infrastructure topology.

Migration note: in the Personal form, OMP uses CBM's native tool surface directly, and BaiZe Skills are written against it. Introducing the gateway's logical surface later means revising the Skills — accepted as a deliberate incremental-scale trade-off.

### 13.4 Optional two-stage retrieval

If global retrieval at 800+ repos becomes the bottleneck:

1. **Recall** — Zoekt: which repos/files are likely relevant (fast, global, cheap).
2. **Understanding** — CBM on the selected repos only: symbols, graph traversal, callers/callees, impact.
3. **Reasoning** — OMP synthesizes evidence into the final answer.

### 13.5 Authentication and authorization [Enterprise]

A user must never receive code or derived knowledge from repositories they cannot access. Authorization must be enforced before search, file retrieval, graph traversal, cross-repo fan-out, architecture responses, and answer generation. Potential sources: GitHub/GitLab permissions, internal IAM, manually managed repo groups.

(Contrast with the Personal form, §3.1: authorization is delegated to the user's own SCM credentials, and all components run as that user.)

### 13.6 Audit [Enterprise]

Record: requesting user, timestamp, repositories queried, MCP tools invoked, query metadata, returned repo scope, denied access, indexing/admin operations. Avoid logging full sensitive source payloads by default (the PAT/logging rule in §7.2 applies in all forms).

### 13.7 Observability [Enterprise]

Recommended metrics once the shared form exists:

- **Fleet**: total/healthy/stale repos, sync failures, last successful fetch, webhook lag.
- **Indexing**: queue depth, active jobs, duration, failures, indexed LOC/files, last indexed commit, incremental latency.
- **Query**: QPS, P50/P95/P99, fan-out width, per-engine latency, result counts, MCP error rate.
- **Resources**: CPU, memory, disk, SQLite/WAL size, open files, worker concurrency.

The Personal form needs only a minimal subset visible in the UI: per-repo sync/index state, last indexed commit, index size on disk.

### 13.8 Availability and concurrency [Enterprise]

Initial: stable central service, controlled indexing concurrency, multiple simultaneous users, no duplicate indexing work, query availability during background indexing. Later: gateway replicas, shard health checks, query failover, distributed index workers, zero-downtime upgrades.

## 14. Evaluation Dataset

Create at least 50–100 real engineering questions against the organization's own GitLab estate, covering:

1. code location,
2. caller/callee,
3. cross-repo service flow,
4. event/Kafka tracing,
5. architecture,
6. dependency inventory,
7. change impact,
8. business-logic explanation,
9. ambiguous debugging questions,
10. organization-wide code inventory.

Each question must have a human-reviewed expected answer or evidence set, including a **labeled set of relevant repositories** (needed for the recall metric, §15).

## 15. Success Metrics

### Answer quality

- **≥ 80% useful-answer rate** on the MVP benchmark. _Method_: two human reviewers rate each answer against a rubric (useful = substantively correct + evidence-backed + actionable); disagreements resolved by a third reviewer.
- **≥ 90% of material claims backed by valid source evidence.** _Method_: automated check that each citation resolves (file/line range exists at the indexed revision) + human sampling of claim↔evidence entailment.
- **Low hallucination rate.** _Method_: rate of material claims contradicted by their cited evidence. Numeric threshold set after the first benchmark run (v0.1 had no method and no number).

### Retrieval

- **Relevant-repository recall ≥ 95%** on benchmark questions. _Method_: measured against the human-labeled relevant-repo sets in the evaluation dataset.
- No unauthorized-repository leakage. _Personal form_: holds by construction (credential delegation, §3.1); verified by confirming the indexed repo set matches the PAT's visible set.

### Scale

- Personal form: S1–S2 milestones with acceptable indexing latency and UI responsiveness; exact SLOs defined after the first scale benchmark.
- Enterprise form: 800+ repos, tens of millions to 100M+ LOC, incremental updates without full re-index, practical concurrency — SLOs defined at Phase 3.

## 16. Development Phases

(Renumbered and deduplicated against v0.1; scale milestones now live in §12.)

### Phase 0 — Technical validation

- Run the CBM validation checklist (§17).
- Panda-derived UI + OMP + CBM chain working end-to-end on 5–20 repositories.
- Confirm basic answer quality informally.

### Phase 1 — MVP / real PoC

- §11 deliverables on 50–100 repositories (milestone S2).
- Benchmark question set executed with measurement methods (§15).
- Indexing and query metrics collected.

### Phase 2 — Personal-form scale validation

- 200 repos (S3); attempt 500 (S4) only if S3 is comfortable.
- Stress indexing and queries; measure storage and WAL behavior.
- Decide whether the Personal form has a hard ceiling and what triggers the Enterprise form.

### Phase 3 — Enterprise layer [Enterprise]

Only proven gaps: gateway/routing, fleet controller with webhooks, multi-SCM, sharding, ACL, audit, observability.

### Phase 4 — Optional Zoekt [Enterprise]

Only if global retrieval through CBM fails latency/recall targets.

## 17. Phase 0 — CBM Technical-Validation Checklist

Each item has a pass criterion; failure triggers a documented fallback decision (wrap, patch, or replace).

| # | Question | Method | Pass criterion |
| - | -------- | ------ | -------------- |
| 1 | **Distribution/runtime**: CBM's static binary (npm postinstall, confirmed) and OMP can both be spawned and supervised by the baize CLI — incl. CBM daemon lifecycle ownership and OMP's own runtime requirement (Bun vs prebuilt binary, confirmed — see note below) | Clean-machine test: Node + git only | `npx baize` indexes a repo and answers a question end-to-end (exercises OMP spawn + CBM spawn + UI); offline/locked-down install path via pre-bundled or mirrored binaries documented |

> **OMP runtime — confirmed (issue #9)**: OMP v18.1.15 is a Bun script (`#!/usr/bin/env bun`, requires `bun >= 1.3.14`), distributed as the npm package `@oh-my-pi/pi-coding-agent` (binary `omp`). BaiZe spawns it as `omp --mode=acp --config ~/.baize/omp-overlay.yml` — `--mode=acp` is an undocumented-but-standard ACP mode (JSON-RPC over stdio). The overlay disables the startup update check (`startup.checkUpdate: false`), and the bridge strips all `OTEL_*` variables from the child environment, so no telemetry egress by default. The clean-machine end-to-end item above remains open until exercised on a fresh host.
>
> **MCP wiring — confirmed (issue #10)**: OMP's ACP mode does **not** load project-level `.omp/mcp.json` (verified empirically: zero codebase-memory records in OMP logs; only the user-level `~/.omp/agent/mcp.json` is read, which BaiZe must not touch — it would pollute every OMP session on the host). The working channel is the ACP standard itself: `session/new` / `session/load` / `session/resume` accept an `mcpServers` parameter (per the ACP spec, each element's `env` is an array of `{name, value}` pairs, not an object). BaiZe's bridge injects the CBM server (binary from `node_modules`, `--ui=false`, `CBM_CACHE_DIR` pointed at the index cache) into those requests before forwarding; client-declared servers with the same name win. Verified end-to-end: the model discovers and calls `mcp__codebase-memory__*` tools and answers with file:line citations.
| 2 | **Multi-repo store**: can one CBM instance hold multiple repositories with repo-scoped queries? | Index 20 repos into one store; run scoped and unscoped queries | Queries correctly scope by repo; no cross-contamination of results |
| 3 | **Cross-repo relationships**: quantify CBM's `cross-repo-intelligence` mode per relationship type — HTTP routes, gRPC, GraphQL, async topics (**Kafka explicitly; upstream matching is partial**), proto imports | Index 3–5 repos with known cross-repo links; run `index_repository` in `cross-repo-intelligence` mode with `target_projects`; query for each known link | Hit-rate **and false-positive rate** per relationship type recorded (upstream has both failure modes: #523 misses, #1459 false positives); thresholds set at first run — the numbers themselves are the deliverable |

> **Cross-repo relationships — measured (issue #14, 2026-09-09, CBM 0.10.8)**: HTTP 2/4 (misses: axios instance methods; inline-arrow server handler — the named-handler constraint is now measured, not just source-verified), channel 1/1, Kafka/kafkajs 0/2 (extractor emits no ASYNC_CALLS for kafkajs), gRPC 0/1 and GraphQL 0/1 (no matching pass upstream). 0 false positives; string-URL trap held; the two Kafka traps are held vacuously (nothing async to conflate). Full numbers and go/adjust decisions in §8.2. Harness: `benchmark/crossrepo/measure.mjs` — re-run on every CBM upgrade.
| 4 | **Incremental indexing**: does a push trigger index update without full re-index? | Push a representative commit; measure latency and changed-work scope | Incremental latency in seconds-to-minutes; no full re-index |
| 5 | **Scale smoke**: size/time/memory for 20 representative repos | Measure during item 2 | Numbers recorded as S1 baseline; no runaway WAL/disk growth |
| 6 | **Query latency**: P50/P95 on a fixed 20-question probe set | Script the probes against the MCP tools | Latencies recorded; flag anything P95 > 5s for investigation |
| 7 | **Desktop sidecar feasibility**: package the baize server as a plain Node binary + JS bundle Tauri sidecar (per §6.5; SEA rejected as primary because `child_process.fork` breaks by design) | Build the sidecar; spawn git, OMP, and CBM from it; verify process-tree cleanup on app quit | Works signed (hardened runtime + JIT entitlements) on macOS; Windows/Linux assessed |
| 8 | **WAL/daemon soak**: CBM has open WAL-growth and daemon-stability issues (#1083: 115 GB WAL in 4.5 h under concurrent index workers; #581: slow memory leak; #1955/#2107: daemon client timeouts/wedges) | Index 20 repos while running query load; watch WAL size, daemon restarts, and memory over 24 h | WAL bounded by configured caps and checkpointing; no daemon wedge; memory stable |

## 18. Key Technical Risks

### CBM distribution/runtime

Confirmed spawnable as an MCP stdio static binary (npm postinstall download). OMP's runtime requirement is now confirmed (Bun script, `@oh-my-pi/pi-coding-agent`; §17 item 1 note) and BaiZe's ACP bridge spawns it with telemetry opted out (update-check overlay + `OTEL_*` env scrubbing). Residual risk: postinstall needs network access to GitHub Releases, and OMP additionally requires Bun ≥ 1.3.14 on the host (not bundled) — the clean-machine test (§17 item 1) must verify the failure mode when Bun is absent and document the remediation. _Mitigation_: Phase 0 item 1; pre-bundle or mirror binaries for locked-down environments; detect missing Bun early with an actionable error.

### CBM capability gap

Cross-repo relationship quality is now measured (Phase 0 item 3, §8.2): HTTP-route and channel matching work with strict source-form constraints, while Kafka/kafkajs, gRPC, and GraphQL cross-repo edges do not exist on CBM 0.10.8. The numbers move with every CBM upgrade — upstream issues show both misses and false positives (#523, #1459, #953, #706). _Mitigation_: re-run `benchmark/crossrepo/measure.mjs` on every upgrade; BaiZe Skills and search-augmented investigation compensate where static analysis falls short; §8.2/§8.4 commitments already reflect the measured boundary.

### CBM project maturity (new)

CBM is ~6.5 months old with 500+ open issues, and a community fork exists because of slow upstream merges. _Mitigation_: pin an exact CBM version in the npm package; budget for tracking upstream; verify every upgrade against the Phase 0 checklist before rolling it out.

### CBM serverization maturity

CBM is primarily a local MCP/code-memory engine (per-account daemon, no network transport — upstream #709), not an enterprise multi-tenant cluster. _Mitigation_ (Enterprise form): isolate behind the gateway, hide topology from agents, shard if necessary.

### SQLite concurrency / WAL growth

Concrete upstream evidence: #1083 (WAL grew to 115 GB in 4.5 h under concurrent index workers), #1174 (stuck/oversized WAL on Windows), #1206 (multi-instance DB quarantine contention). _Mitigation_: bound indexing concurrency, own the daemon lifecycle from the baize CLI, apply CBM's WAL size bounds, run the Phase 0 soak (§17 item 8), benchmark at each scale milestone.

### CBM daemon is a per-account global singleton (new, #13)

The daemon binds to the first-seen `CBM_CACHE_DIR` for the active account; a second CBM session started with a *different* cache dir exits immediately ("active account daemon uses a different cache directory"). Orphaned sessions (e.g. an unclean shutdown) keep the daemon committed and block other cache dirs until reaped. _Mitigation_: one baize home per machine/account (the Personal-form deployment model); the supervisor kills the daemon on shutdown (`daemon stop` fallback reaps leftovers); the failure surfaces as an actionable error instead of a hang.

### Cross-repository graph quality

Static analysis cannot always infer dynamic service relationships. _Mitigation_: combine graph evidence with search; encode organization-specific conventions in BaiZe Skills; let Skills guide agent investigation.

### Git credential UX (new)

Ambient git auth fails in varied ways (SSH agent not loaded, credential helper missing, expired PAT). _Mitigation_: `needs-auth` state + actionable UI remediation (§7.3); keep failure modes enumerated in docs as they are encountered.

### ACL leakage through derived results [Enterprise]

Graph relationships can indirectly expose restricted repository information. _Mitigation_: authorization at evidence/result level; filter traversal by authorized repo scope. Personal form: holds by construction (§3.1).

## 19. Open Questions

Resolved in v0.2: deployment form (§3); repo onboarding (Fleet in MVP, §7); branch policy (default branch, per-repo override, §7.1); ACL in Personal form (credential delegation, §3.1); UI source (Panda-derived, §6.3). Resolved in v0.2.1: OMP identity (Oh My Pi, §5); desktop sidecar packaging path (§6.5). Resolved by #9: OMP runtime requirement (Bun script, spawned via `omp --mode=acp` with telemetry opted out — §17 item 1 note). Resolved by #11: minimal GitLab PAT scopes (`read_api`; §7.2). Resolved by #12: fetch semantics of §7.3 — `git clone --mirror` leaves HEAD at the source's default branch and `remote update --prune` keeps all refs current, so `rev-parse refs/heads/<branch>` is a truthful per-repo revision signal for any branch that exists; caveat: HEAD is a symref fixed at clone time, so if a project changes its default branch upstream, the mirror's HEAD (and the override-less reading) follows the old branch until re-cloned. Backoff schedule fixed at 1/5/15/60/240/1440 minutes, manual sync overrides the window.

Remaining, each annotated with what it blocks:

1. Can a single CBM store reliably support the target estate? — **blocks Phase 3 design**; informed by §17 items 2/5/8.
2. What is the optimal shard size? — Phase 3.
3. How well does CBM resolve Go/Rust/Java/TypeScript cross-repo relationships? — **Phase 0, §17 item 3**. (Single-repo type resolution for these languages is benchmarked "Good" 75–89% upstream; the open part is cross-repo edge quality.)
4. How should generated/vendor code be excluded? — Phase 1 (needed for honest index-size numbers).
5. ~~Branch policy~~ — resolved (§7.1).
6. Is Zoekt required for global retrieval? — Phase 4 decision point.
7. What concurrency is expected from engineering teams? — Phase 3.
8. How should repo ACLs be synchronized from SCM systems? — Phase 3.
9. Do we need PR/Issue/ADR context in V1, or only source code? — Phase 3 scoping.
10. Should architecture graph state be persisted separately from CBM? — Phase 3.
11. ~~Which GitLab PAT scopes are minimally sufficient (`read_api` ± `read_repository`)?~~ — resolved (#11): `read_api` alone (§7.2).

## 20. Current Recommended Direction

Build the **Personal form** first:

```text
npx baize  =  BaiZe UI (Panda-derived) + OMP + CBM + GitLab fleet
```

Do **not** build a custom BaiZe code-intelligence backend, and do not build the enterprise layer until Personal-form scale validation proves the gaps.

The expected long-term role of BaiZe is:

> **Fleet, security, routing, and agent-skills layer around reusable open-source code-intelligence engines — starting as a single-user local tool and growing into the enterprise control plane only where reality demands it.**
