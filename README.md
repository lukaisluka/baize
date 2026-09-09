# BaiZe

Local-first multi-repo code Q&A over your GitLab fleet. Ask questions about
your organization's repositories; answers carry verifiable repo/file/line
citations backed by a local code index.

Status: **skeleton** — `npx baize` starts a local server with a placeholder
page. See the [PRD](docs/prd.md) for the full architecture and roadmap.

## Run

Requires Node.js ≥ 20 and system `git`.

```sh
npx baize            # random port, opens the browser
npx baize -p 8080    # explicit port
npx baize --no-open  # do not open the browser
```

The process binds 127.0.0.1 only and runs in the foreground; Ctrl-C stops it.

The page served at `/` lists indexed repositories. Point it at a local git
repository (work tree or bare mirror) — e.g. via `curl`:

```sh
curl -X POST http://127.0.0.1:PORT/api/repos \
  -H 'content-type: application/json' -d '{"path": "/abs/path/to/repo"}'
```

BaiZe spawns [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
(CBM) as a supervised child process on first use and indexes the repo into a
local code graph; status and symbol/relation counts appear on the page and via
`GET /api/repos`. On shutdown BaiZe tears down the CBM child and its daemon.

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
├── config.json   # defaults; will hold GitLab URL + PAT (chmod 600)
├── repos/        # bare mirror clones (fleet sync, upcoming)
├── index/        # CBM data (per-project SQLite DBs)
└── logs/         # baize.log — startup, requests, CBM lifecycle, shutdown
```

## Develop

```sh
npm install   # postinstall downloads the CBM binary (see above)
npm test      # node --test; CBM integration tests skip if the binary is absent
npm start     # run from checkout
```

Layout: `src/` is the server + orchestrator; `test/` mirrors it. The
Panda-derived SPA will be vendored into `ui/` (issue #9).
