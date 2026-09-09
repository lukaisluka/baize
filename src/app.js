import { ensureDataLayout, resolveHome } from './paths.js'
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { close, createBaizeServer, listen } from './server.js'
import { openBrowser } from './open-browser.js'

// Composition root: data layout -> config -> logger -> HTTP server -> browser.
// Everything after the listen is wiring for later issues; each stage logs so
// a start failure is traceable from ~/.baize/logs/baize.log.
export async function startApp({
  home = resolveHome(),
  port,
  openBrowser: shouldOpen = true,
  stdout = process.stdout,
} = {}) {
  const dirs = ensureDataLayout(home)
  const config = loadConfig(home)
  const logger = createLogger(dirs.logs)

  const server = createBaizeServer({ logger })
  const bound = await listen(server, { port: port ?? config.port })
  const url = `http://${bound.host}:${bound.port}`

  logger.info(`baize listening on ${url} (home: ${home})`)
  stdout.write(`BaiZe running at ${url}\n`)

  if (shouldOpen && (config.openBrowser !== false)) {
    openBrowser(url, { logger })
  }

  return {
    url,
    port: bound.port,
    home,
    server,
    async stop() {
      logger.info('shutting down')
      await close(server)
    },
  }
}
