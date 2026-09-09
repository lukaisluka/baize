#!/usr/bin/env node
/**
 * Sidecar packager for the BaiZe desktop shell (#18, PRD §6.5).
 *
 * Assembles desktop/src-tauri/resources/baize/ — the plain-Node sidecar the
 * Tauri shell spawns (NOT Node SEA: `child_process.fork` is broken by design
 * in SEA binaries, and the baize server forks git/OMP/CBM children):
 *
 *   bin/node        the platform's official Node binary (downloaded from
 *                   nodejs.org dist once, cached in ~/.cache/baize-sidecar)
 *   src/            the server sources, as-is (no bundling: src/cbm.js
 *                   resolves codebase-memory-mcp's binary from node_modules
 *                   at runtime — a bundle would break that path)
 *   node_modules/   production deps only (npm install --omit=dev), which
 *                   also runs codebase-memory-mcp's postinstall to fetch its
 *                   static binary
 *   ui/dist/        the built web UI
 *   package.json    version metadata src/cli.js reads
 *
 * Usage: node desktop/scripts/package-sidecar.mjs [--node-version vX.Y.Z]
 * Then:  cargo build (the shell resolves resources/ relative to the binary
 *        in dev) or `tauri build` for a bundle.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform, arch } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = join(repoRoot, 'desktop', 'src-tauri', 'resources', 'baize')
const cacheDir = join(homedir(), '.cache', 'baize-sidecar')

// nodejs.org dist naming for this host.
function distPlatform() {
  const p = platform()
  const a = arch()
  const os = p === 'darwin' ? 'darwin' : p === 'linux' ? 'linux' : p === 'win32' ? 'win' : null
  if (!os) throw new Error(`unsupported platform: ${p}`)
  const cpu = { arm64: 'arm64', x64: 'x64', arm: 'armv7l' }[a]
  if (!cpu) throw new Error(`unsupported arch: ${a}`)
  return `${os}-${cpu}`
}

// Match the running Node by default — the sidecar behaves exactly like the
// npm CLI (`npx baize`) does on this machine. Both `--node-version v1.2.3`
// and `--node-version=v1.2.3` forms are accepted.
function parseArgs(argv) {
  let version = process.version
  for (const arg of argv) {
    if (arg === '--node-version' || arg.startsWith('--node-version=')) {
      version = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[argv.indexOf(arg) + 1]
    }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`--node-version: expected e.g. v24.16.0, got "${version}"`)
  }
  return { version }
}

/** Verify the downloaded archive against nodejs.org's published SHASUMS256.
 * HTTPS alone is transport trust; the checksum pins the artifact. */
async function verifySha256(version, archiveName, archivePath) {
  const res = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)
  if (!res.ok) throw new Error(`cannot fetch SHASUMS256.txt: ${res.status}`)
  const sums = await res.text()
  const line = sums.split('\n').find((l) => l.trim().endsWith(archiveName))
  if (!line) throw new Error(`${archiveName} not listed in SHASUMS256.txt for ${version}`)
  const expected = line.trim().split(/\s+/)[0].toLowerCase()
  const hash = createHash('sha256')
  hash.update(await readFile(archivePath))
  const actual = hash.digest('hex')
  if (actual !== expected) {
    rmSync(archivePath, { force: true })
    throw new Error(`sha256 mismatch for ${archiveName}: expected ${expected}, got ${actual} — deleted, retry the download`)
  }
}

async function downloadNodeBinary(version) {
  const plat = distPlatform()
  const ext = platform() === 'win32' ? 'zip' : 'tar.gz'
  const archiveName = `node-${version}-${plat}.${ext}`
  const url = `https://nodejs.org/dist/${version}/${archiveName}`
  const cachePath = join(cacheDir, archiveName)
  const binaryCache = join(cacheDir, `node-${version}-${plat}`)

  if (existsSync(binaryCache)) {
    console.log(`node ${version} (${plat}): cache hit at ${binaryCache}`)
    return binaryCache
  }
  mkdirSync(cacheDir, { recursive: true })
  // Stale extraction attempts from an interrupted run would otherwise be
  // adopted as a cache hit below — the rename only happens on full success.
  for (const stale of readdirSync(cacheDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(`node-${version}-${plat}.tmp.`))
    .map((e) => join(cacheDir, e.name))) {
    console.log(`removing stale partial extraction ${stale}`)
    rmSync(stale, { recursive: true, force: true })
  }
  if (!existsSync(cachePath)) {
    console.log(`downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
    await pipeline(res.body, createWriteStream(cachePath))
    const size = statSync(cachePath).size
    if (size < 1_000_000) throw new Error(`downloaded archive implausibly small (${size} bytes) — refusing`)
  }
  await verifySha256(version, archiveName, cachePath)
  // Extract to a temp dir, then atomically rename into the cache slot: an
  // interrupted extraction must never become tomorrow's cache hit.
  const tmpDir = join(cacheDir, `node-${version}-${plat}.tmp.${process.pid}`)
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('tar', ['-xzf', cachePath, '-C', tmpDir, '--strip-components', '1'])
  renameSync(tmpDir, binaryCache)
  console.log(`node ${version} (${plat}): extracted to ${binaryCache}`)
  return binaryCache
}

function copyDir(from, to, { skip = () => false } = {}) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip(entry)) continue
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst, { skip })
    else if (entry.isSymbolicLink()) {
      // Preserve relative symlinks (npm uses them in node_modules); resolve
      // absolute ones to their target as a plain copy.
      const target = readlinkSync(src)
      if (!target.startsWith('/')) symlinkSync(target, dst)
      else copyFileSync(src, dst)
    } else copyFileSync(src, dst)
  }
}

async function main() {
  const { version } = parseArgs(process.argv.slice(2))

  // UI first: its absence would ship a server that serves the remedy page.
  const uiDist = join(repoRoot, 'ui', 'dist')
  if (!existsSync(join(uiDist, 'index.html'))) {
    throw new Error(`UI not built (${uiDist}/index.html missing) — run: npm run build:ui`)
  }

  console.log(`packaging sidecar into ${outDir}`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(join(outDir, 'bin'), { recursive: true })

  // 1. Node binary
  const nodeDir = await downloadNodeBinary(version)
  const nodeSrc = platform() === 'win32' ? join(nodeDir, 'node.exe') : join(nodeDir, 'bin', 'node')
  if (!existsSync(nodeSrc)) throw new Error(`node binary not found in archive: ${nodeSrc}`)
  copyFileSync(nodeSrc, join(outDir, 'bin', platform() === 'win32' ? 'node.exe' : 'node'))
  if (platform() !== 'win32') execFileSync('chmod', ['+x', join(outDir, 'bin', 'node')])

  // 2. Server sources — as-is, no bundling (see header comment).
  copyDir(join(repoRoot, 'src'), join(outDir, 'src'), { skip: (e) => e.name === 'benchmark' })

  // 3. package.json (version metadata) + production node_modules. A separate
  // install keeps dev-only deps (and their size) out of the bundle; the
  // postinstall of codebase-memory-mcp downloads its static binary, which is
  // exactly what the sidecar needs on a clean machine.
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const slim = { name: manifest.name, version: manifest.version, type: manifest.type, dependencies: manifest.dependencies }
  writeFileSync(join(outDir, 'package.json'), `${JSON.stringify(slim, null, 2)}\n`)
  console.log('installing production node_modules (runs CBM postinstall — needs network)')
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], {
    cwd: outDir,
    stdio: 'inherit',
  })

  // 4. UI
  copyDir(uiDist, join(outDir, 'ui', 'dist'))

  console.log(`sidecar ready: ${outDir}`)
  console.log('next: cargo build --manifest-path desktop/src-tauri/Cargo.toml')
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack ?? err.message}`)
  process.exit(1)
})
