import { ensureDataLayout, resolveHome } from './paths.js'
import { loadConfig, saveConfig } from './config.js'
import { createLogger } from './logger.js'
import { close, createBaizeServer, listen } from './server.js'
import { openBrowser } from './open-browser.js'
import { CbmSupervisor } from './cbm.js'
import { createRepoRegistry } from './repos.js'

// Composition root: data layout -> config -> logger -> CBM + repo registry ->
// HTTP server -> browser. CBM is supervised but lazy — nothing spawns until
// the first repo is submitted — and every stage logs so a failure anywhere is
// traceable from ~/.baize/logs/baize.log.
export async function startApp({
  home = resolveHome(),
  port,
  openBrowser: shouldOpen = true,
  stdout = process.stdout,
} = {}) {
  const dirs = ensureDataLayout(home)
  const config = loadConfig(home)
  const logger = createLogger(dirs.logs)

  const cbm = new CbmSupervisor({ cacheDir: dirs.index, logger })
  const registry = createRepoRegistry({ config, save: () => saveConfig(home, config), logger, cbm })

  const server = createBaizeServer({ logger, registry })
  const bound = await listen(server, { port: port ?? config.port })
  const url = `http://${bound.host}:${bound.port}`

  logger.info(`baize listening on ${url} (home: ${home})`)
  stdout.write(`BaiZe running at ${url}\n`)

  if (shouldOpen && config.openBrowser !== false) {
    openBrowser(url, { logger })
  }

  return {
    url,
    port: bound.port,
    home,
    server,
    cbm,
    registry,
    async stop() {
      logger.info('shutting down')
      await close(server)
      // Server first (no new CBM calls), then the CBM child + its daemon.
      await cbm.stop()
    },
  }
}
