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
- **`/fleet`** — indexed-repository status.
- **`/api/*`** — health and repo management (below).

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
├── config.json      # defaults; agentCommand here; will hold GitLab URL + PAT (chmod 600)
├── omp-overlay.yml  # OMP telemetry opt-out, written once by baize (editable)
├── agent/           # working directory for spawned agent processes
├── repos/           # bare mirror clones (fleet sync, upcoming)
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
