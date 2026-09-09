# BaiZe

Local-first multi-repo code Q&A over your GitLab fleet. Ask questions about
your organization's repositories; answers carry verifiable repo/file/line
citations backed by a local code index.

Status: **skeleton** — `npx baize` starts a local server serving the
Panda-derived chat UI at `/` and a fleet status page at `/fleet`. See the
[PRD](docs/prd.md) for the full architecture and roadmap.

## Run

Requires Node.js ≥ 20 and system `git`.

```sh
npx baize            # random port, opens the browser
npx baize -p 8080    # explicit port
npx baize --no-open  # do not open the browser
```

The process binds 127.0.0.1 only and runs in the foreground; Ctrl-C stops it.

## What it serves

- **`/`** — the chat UI (vendored from
  [Panda](https://github.com/lukaisluka/panda), `ui/`; see `ui/VENDORED.md`).
  It is a pure protocol client: it never spawns processes, it connects a
  WebSocket to `/acp` on this server. Each WebSocket connection spawns one
  agent child process; the bridge frames WebSocket messages to stdio
  JSON-RPC lines and back. Closing the tab terminates the agent.
- **`/fleet`** — GitLab connection + repo discovery + mirror sync + indexing.
  Paste your
  GitLab base URL and a PAT (`read_api` scope is enough), then discover a
  group recursively or an explicit repo list. Discovered repos clone as bare
  mirrors under `~/.baize/repos/` and stay current via polling (default 15m)
  plus manual **Sync now** (globally or per repo); per-repo branch overrides
  pin the tracked branch. Each mirror materializes a linked worktree at the
  tracked revision under `~/.baize/worktrees/` — the readable checkout the
  code index is built from (the bare mirror itself has no working tree).
  Every tracked-revision change re-indexes that repo automatically (same
  revision = no-op, failures retry with exponential backoff); the fleet table
  shows index state and the last indexed revision. Cloning uses system git
  with your ambient
  credentials (SSH agent / credential helper) — the PAT is never embedded in
  a remote URL, and remote URLs returned by discovery are allowlisted to
  https/ssh/git transports (no `ext::`, no local paths). Git authentication
  failures mark the repo `needs-auth` and back off exponentially; manual sync
  overrides the backoff. The token is stored in `~/.baize/config.json`
  (0600), used only for GitLab API calls, never echoed back to any UI or
  written to logs.
- **`/api/*`** — health, repos, GitLab settings/discovery, and mirror-sync
  state/control endpoints.

### Agent (OMP)

The chat UI talks to whatever agent the `/acp` bridge spawns — by default
[`omp`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) (Oh My Pi).
OMP is a Bun script and requires [Bun](https://bun.sh) ≥ 1.3.14 on the
host (`curl -fsSL https://bun.sh/install | bash`, or
`npm i -g @oh-my-pi/pi-coding-agent` if Bun is already present). Override
the command in `~/.baize/config.json` (`agentCommand`).

Telemetry is off by default: BaiZe spawns OMP with
`--mode=acp --config ~/.baize/omp-overlay.yml`, where the overlay disables
the startup update check, and strips all `OTEL_*` variables from the
agent's environment.

The bridge gives the agent two things on every connection:

- **CBM as a live tool server.** OMP's ACP mode ignores project-level
  `.omp/mcp.json`, so the bridge injects the `codebase-memory` MCP server
  (the bundled CBM binary, pointed at BaiZe's index cache) into the ACP
  `session/new|load|resume` requests before they reach OMP. Client-declared
  servers with the same name win.
- **A generated `~/.baize/agent/AGENTS.md`** — the fleet listing (project
  names, indexed revisions, worktree paths) plus the citation rules: answer
  from the index, not memory; every factual claim carries a
  `<project>/<path>:<line>` citation; say so when the index has nothing.

The chat UI marks the converse: a finished turn whose answer cites no tool
evidence at all shows a trailing "unverified" notice.

## Repos & code index

Point the server at a local git repository (work tree or bare mirror) —
e.g. via `curl`:

```sh
curl -X POST http://127.0.0.1:PORT/api/repos \
  -H 'content-type: application/json' -d '{"path": "/abs/path/to/repo"}'
```

BaiZe spawns [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
(CBM) as a supervised child process on first use and indexes the repo into a
local code graph; status and symbol/relation counts appear on the `/fleet`
page and via `GET /api/repos`. On shutdown BaiZe tears down the CBM child
and its daemon.

### CBM binary

The npm package `codebase-memory-mcp` downloads a static, checksum-verified
binary from GitHub Releases at `npm install` time (postinstall — needs
network). BaiZe resolves the binary directly and fails fast with a remedy if
it is missing. Offline / locked-down alternatives:

- After `npm install --ignore-scripts`, trigger the package's own one-time
  download once: `npx codebase-memory-mcp --version` (its launcher downloads
  the binary when absent). BaiZe itself never downloads at runtime.
- Pre-seed `node_modules/codebase-memory-mcp/bin/codebase-memory-mcp` from an
  internal mirror of a GitHub Release asset (keep the executable bit).

CBM state lives under `~/.baize/index/` (`CBM_CACHE_DIR` is redirected there;
one SQLite DB per indexed project).

All state lives under `~/.baize/` (override with `BAIZE_HOME`):

```text
~/.baize/
├── config.json      # GitLab URL + PAT (chmod 600), poll interval, branch overrides; agentCommand here
├── omp-overlay.yml  # OMP telemetry opt-out, written once by baize (editable)
├── agent/           # working directory for spawned agent processes; AGENTS.md regenerated per connection
├── repos/           # bare mirror clones kept current by fleet sync
├── worktrees/       # linked worktrees at tracked revisions — what gets indexed
├── index/           # CBM data (per-project SQLite DBs)
└── logs/            # baize.log — startup, requests, CBM/agent lifecycle, shutdown
```

## Develop

```sh
npm install          # postinstall downloads the CBM binary (see above)
npm run build:ui     # typecheck + build the vendored SPA -> ui/dist
npm test             # node --test; CBM integration tests skip if the binary is absent
npm start            # run from checkout
```

Layout: `src/` is the server + orchestrator; `test/` mirrors it; `ui/` is the
vendored Panda SPA (see `ui/VENDORED.md` for provenance and porting rules).
Without `ui/dist` the server serves a build instruction page at `/`.
