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

All state lives under `~/.baize/` (override with `BAIZE_HOME`):

```text
~/.baize/
├── config.json   # defaults; will hold GitLab URL + PAT (chmod 600)
├── repos/        # bare mirror clones (fleet sync, upcoming)
├── index/        # CBM code index (upcoming)
└── logs/         # baize.log — startup, requests, shutdown
```

## Develop

```sh
npm install   # no runtime dependencies
npm test      # node --test
npm start     # run from checkout
```

Layout: `src/` is the server + orchestrator; `test/` mirrors it. The
Panda-derived SPA will be vendored into `ui/` (issue #9).
