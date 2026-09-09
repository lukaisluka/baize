#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { startApp } from './app.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

const HELP = `baize ${version} — local-first multi-repo code Q&A

Usage:
  baize [options]

Options:
  -p, --port <number>   Port to bind on 127.0.0.1 (default: random free port)
      --no-open         Do not open the browser
  -v, --version         Print version and exit
  -h, --help            Show this help and exit

Data lives in ~/.baize/ (override with BAIZE_HOME).
Spec: docs/prd.md §6.
`

function parse(argv) {
  try {
    return parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        'no-open': { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      argv,
    })
  } catch (err) {
    process.stderr.write(`baize: ${err.message}\n\n${HELP}`)
    process.exit(2)
  }
}

async function main() {
  const args = parse(process.argv.slice(2))

  if (args.values.version) {
    process.stdout.write(`${version}\n`)
    return
  }
  if (args.values.help) {
    process.stdout.write(HELP)
    return
  }

  let port
  if (args.values.port !== undefined) {
    port = Number(args.values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid port: ${args.values.port}`)
    }
  }

  const app = await startApp({
    port,
    openBrowser: !args.values['no-open'],
  })

  // Ctrl-C (dev-tool style, PRD §6.2) and SIGTERM (the future Tauri sidecar's
  // kill signal, §6.5) share one graceful path: close the server, then exit.
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) {
      // Second Ctrl-C while a close is hanging: force-exit rather than ignore.
      process.exit(1)
    }
    shuttingDown = true
    try {
      await app.stop()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  process.stderr.write(`baize: ${err?.stack || err}\n`)
  process.exit(1)
})
