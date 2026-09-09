# Vendored from Panda

This directory is BaiZe's UI, vendored from Panda's web code — not consumed
as an npm dependency (PRD §6.3). Panda evolves independently; porting
upstream fixes is manual until a shared package is justified.

- **Upstream**: https://github.com/lukaisluka/panda (local checkout:
  `/Users/luka/Projects/panda`)
- **Vendored at**: commit `e6c56ef` (2026-09-09, "docs: state the macOS
  Gatekeeper workaround in download notes (#248) (#249)")
- **License**: Apache-2.0 (see LICENSE in this directory)

## What was excluded from the upstream tree

| Excluded        | Why                                                        |
| --------------- | ---------------------------------------------------------- |
| `desktop/` (repo root) | Tauri shell — separate concern (#18), not needed for web UI. Note `src/desktop/boot.ts` is **kept**: the shared web build imports it (`main.tsx`), and `@tauri-apps/api` no-ops in a plain browser |
| `desktop-acceptance.html` | manual acceptance page for Panda's desktop shell (#18) |
| `test-agent/`   | Panda's own test agent; baize has its own bridge. **Exception**: `test-agent/fixtures/` is kept — `src/acp/claudeCodeContract.test.ts` reads the recorded claude-code wire fixtures during describe collection, so the suite goes red without them |
| `docs/`         | Panda's docs; the bridge spec it carries is implemented in baize's `src/acp-bridge.js` |
| `branding/`     | Panda brand assets                                          |
| `dist/`         | Build output (rebuilt here)                                 |
| workspace files | `pnpm-workspace.yaml`, `pnpm-lock.yaml` — baize uses npm workspaces |
| `.github/`       | Panda's own CI (pages deploy, desktop builds) — inert inside `ui/` and misleading; baize CI lives at the repo root |
| top-level md    | Panda's README/CONTEXT/DESIGN/CHANGELOG stay upstream       |

## Local modifications

- `package.json`: renamed to `baize-ui`, private; removed the `desktop:*`
  workspace scripts and the `@tauri-apps/cli` devDependency (desktop build
  tool). `@tauri-apps/api` stays — the shared web/desktop build imports it
  and it no-ops in a plain browser.
- Everything else is byte-identical to upstream to keep future ports
  mechanical. Prefer upstream-shaped changes (patch here the same way the
  upstream fix looks) over divergent rewrites.

## Porting an upstream fix

1. `git -C /path/to/panda log` to find the fix; note the hash here.
2. `git diff <before>..<after> -- src/ index.html public/` and apply the
   relevant hunks into this directory.
3. `npm run build -w ui` and exercise the affected surface.

## Build

```sh
npm install            # from repo root — installs the ui workspace too
npm run build -w ui    # typecheck + vite build -> ui/dist
```

The baize server serves `ui/dist` (SPA with index.html fallback) once it
exists. The chat connects to `ws://127.0.0.1:<port>/acp`.
