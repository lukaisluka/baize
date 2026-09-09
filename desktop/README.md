# BaiZe desktop shell (issue #18, PRD §6.5 / §17 item 7 — stretch)

A Tauri 2 shell derived from Panda's `desktop/src-tauri` pattern, reduced to
BaiZe's only browser-impossible jobs:

1. **Own the server process.** The shell spawns the baize server as a
   *plain-Node sidecar* — official per-platform Node binary + the real
   `src/` tree + production `node_modules` + `ui/dist` under
   `src-tauri/resources/baize/` (assembled by `scripts/package-sidecar.mjs`).
   No Node SEA (`child_process.fork` is broken by design in SEA binaries,
   PRD §6.5), no bundling of `src/` (`src/cbm.js` resolves
   `codebase-memory-mcp`'s binary from `node_modules` at runtime — an
   esbuild bundle would break that path). Runtime semantics are identical
   to `npx baize`, so the server's own children (git, OMP/Bun, CBM + its
   daemon) work unchanged.
2. **Kill the whole process tree on quit.** Tauri does not kill sidecar
   children. The shell spawns the sidecar in its own process group
   (POSIX) and on `RunEvent::Exit` SIGTERMs the **group**
   (`kill(-pgid)` — a wedged server cleans up nothing itself, so the
   group kill, not a single-pid kill, is the guarantee) — the server's
   graceful shutdown (`src/cli.js` SIGTERM path: close server, stop sync
   git children, stop CBM + daemon) gets 25 s (its own worst-case budget:
   `cbm.stop`'s 5 s child budget + 15 s `daemon stop` timeout) — then
   SIGKILLs the surviving group. The child is registered in managed
   state immediately after spawn, so quitting during the 30 s startup
   health gate sweeps it too. `kill_on_drop` covers teardown paths that
   reach destructors.

The window is created programmatically after `/api/health` answers, pointed
at the sidecar's dynamically chosen port (that is why `tauri.conf.json`
declares no static window and `frontendDist` is a placeholder). Sidecar
stdout/stderr land in the app log dir (`sidecar.log`).

## Build & run (macOS)

```sh
npm run build:ui                                  # the UI the server serves
node desktop/scripts/package-sidecar.mjs          # downloads Node, installs prod deps, assembles resources
cargo build --manifest-path desktop/src-tauri/Cargo.toml
./desktop/src-tauri/target/debug/baize-desktop
```

The packager caches the Node dist archive under `~/.cache/baize-sidecar/`
(downloads are verified against nodejs.org's published `SHASUMS256.txt`;
extraction is atomic — a temp dir renamed into place — so an interrupted
run can't poison the cache, and concurrent runs are safe: temp dirs carry
the pid, and stale ones from crashed runs are swept on startup);
`--node-version vX.Y.Z` (or `--node-version=vX.Y.Z`) overrides the default
(match-the-running-Node).

### Unbundled release binary

`cargo build --release` is self-sufficient: the build script (tauri-build's
`copy_resources`, driven by the `bundle.resources` map below) copies the
assembled tree to `target/release/baize/`, so the bare binary resolves its
sidecar and runs as-is. Verified: spawn → health gate → group sweep with
zero survivors.

> **Never symlink `target/release/baize` to `resources/baize`.** The build
> script's copy destination *is* `target/release/<map target>`: with that
> symlink in place, `fs::copy`'s destination resolves back to the source
> file itself — `File::create` truncates it to 0 bytes, then the copy
> copies the now-empty file onto itself. No error is raised. tauri-build
> (2.6.3) does have an "avoid copying if target is the same as source"
> check, but it canonicalizes only the source path, so the unresolved
> symlinked destination slips past it. Verified the hard way: one such
> build silently zeroed 1025 of the 1026 files in the assembled tree. If
> it happens: `node desktop/scripts/package-sidecar.mjs` rebuilds
> everything from the pristine repo sources.

### `tauri build` bundles

`bundle.resources` uses the map form — `{"resources/baize": "baize"}` —
which `npx @tauri-apps/cli build` copies into the bundle correctly
(`Contents/Resources/baize/`, full tree including the 120 MB `bin/node`;
verified end-to-end below). The other forms are broken on the current
toolchain (tauri-utils 2.9.3): glob patterns (list or map form) fail the
build with "path not found or didn't match any files", and non-glob
**list** entries silently copy only top-level files, skipping every
directory. Dev builds (`cargo build`, debug profile) copy nothing — the
dev binary resolves resources via `CARGO_MANIFEST_DIR` instead, so the
packager's output under `src-tauri/resources/` serves it directly.

Tauri signs the produced bundle ad-hoc without entitlements; for a
hardened-runtime build, re-sign it (see [Signing](#signing-macos-hardened-runtime--jit-entitlements)
for the mechanics):

```sh
npx @tauri-apps/cli build --bundles app        # produces target/release/bundle/macos/BaiZe.app
APP=desktop/src-tauri/target/release/bundle/macos/BaiZe.app
codesign --force --deep --options runtime \
  --entitlements desktop/src-tauri/entitlements.plist --sign - "$APP"
```

This path is verified end-to-end: the bundled app resolves
`Contents/Resources/baize/bin/node`, passes the health gate under the
hardened runtime with JIT entitlements, and sweeps its whole process
group on quit (see below).

## Signing (macOS, hardened runtime + JIT entitlements)

The sidecar is Node, and V8 needs JIT — under a hardened runtime that
requires entitlements on the shell executable (children inherit the relaxed
flags; that is Apple's documented mechanism for JIT runtimes spawned by a
hardened app):

```sh
codesign --force --options runtime \
  --entitlements desktop/src-tauri/entitlements.plist \
  --sign - <binary-or-app>          # ad-hoc; use your Developer ID for distribution
codesign -dv --entitlements - <binary-or-app>   # verify flags + entitlements
```

`entitlements.plist` carries `com.apple.security.cs.allow-jit` and
`.allow-unsigned-executable-memory` (V8's write-protected code space on
some Node versions). A `.app` bundle via `tauri build` re-signs the nested
binaries; the entitlements file must be passed there too.

Ad-hoc signing (above) validates the hardened-runtime + JIT mechanics
locally; Developer-ID notarized distribution additionally needs a real
certificate and `notarytool` — out of scope for this feasibility issue.

## Windows / Linux assessment (feasibility, not shipped)

- **Windows**: the shell code compiles (`cfg(not(unix))` path), but the
  exit sweep currently covers only the direct child (`Child::kill`) — the
  correct tree-kill primitive there is a **Job Object**
  (`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign the
  sidecar before resume) — TODO before any Windows ship. The packager
  already handles `win-x64`/`win-arm64` Node dist archives (`.zip`
  extraction needs implementing). WebView2 via the `downloadBootstrapper`
  install mode is configured in `tauri.conf.json`.
- **Linux**: nothing platform-specific in the shell beyond the POSIX
  process-group sweep (works as-is); Tauri's webkitgtk dependency and the
  usual distro packaging (deb/AppImage) are the remaining work. Node dist
  archives for `linux-x64`/`linux-arm64` are the same tarball flow.

## Known limits

- **stdio host option in Settings**: Tauri injects `__TAURI_INTERNALS__`
  into every webview, which makes the vendored UI light up its stdio
  agent-host settings (Settings → Agent host). This shell does not
  implement the `stdio_spawn` command behind it, so that option fails
  fast if selected. Needs either a remote capability + command
  implementation or UI suppression — tracked for the desktop follow-up.
- `sidecar.log` is append-only (no rotation); it only ever contains the
  server's stdout banner lines.
- A dev binary launched from a terminal survives the terminal closing
  (independent process group; SIGHUP is not masked) — the .app bundle is
  the intended form.

## Layout

- `src-tauri/src/main.rs` — the shell (spawn, health gate, window, exit sweep)
- `src-tauri/entitlements.plist` — hardened-runtime JIT entitlements
- `src-tauri/tauri.conf.json` — bundle config (icons, dmg/nsis targets,
  `resources` map that ships the sidecar)
- `scripts/package-sidecar.mjs` — sidecar packager
- `resources/baize/` — generated by the packager, git-ignored
