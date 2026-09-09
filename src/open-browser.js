import { spawn } from 'node:child_process'

// Fire-and-forget: detached + unref so the opener can never keep the baize
// process (or its shutdown) alive — the "no orphan processes" acceptance of #7.
export function openBrowser(url, { logger, platform = process.platform, spawnImpl = spawn } = {}) {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]]

  const child = spawnImpl(cmd, args, { stdio: 'ignore', detached: true })
  child.on('error', (err) => {
    // Missing opener binary is not fatal for the server; the URL is on stdout.
    logger?.warn(`could not open browser via ${cmd}: ${err.message}`)
  })
  child.unref()
  return child
}
