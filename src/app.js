import { ensureDataLayout, resolveHome } from './paths.js'
import { loadConfig, saveConfig } from './config.js'
import { createLogger } from './logger.js'
import { close, createBaizeServer, listen } from './server.js'
import { openBrowser } from './open-browser.js'
import { CbmSupervisor } from './cbm.js'
import { createRepoRegistry } from './repos.js'
import { createAcpBridge } from './acp-bridge.js'

// The built SPA: BAIZE_UI_DIST overrides; otherwise ui/dist next to src/
// (repo checkout) — the packed layout (dist/ui) arrives with publishing.
function resolveUiDist(env = process.env) {
  if (env.BAIZE_UI_DIST) return env.BAIZE_UI_DIST
  return new URL('../ui/dist', import.meta.url).pathname
}

// Composition root: data layout -> config -> logger -> CBM + repo registry +
// ACP bridge -> HTTP server -> browser. CBM is supervised but lazy; the ACP
// bridge spawns one agent child per WebSocket connection and reaps them all
// on shutdown. Every stage logs so a failure is traceable from baize.log.
export async function startApp({
  home = resolveHome(),
  port,
  openBrowser: shouldOpen = true,
  stdout = process.stdout,
  uiDist = resolveUiDist(),
} = {}) {
  const dirs = ensureDataLayout(home)
  const config = loadConfig(home)
  const logger = createLogger(dirs.logs)

  const cbm = new CbmSupervisor({ cacheDir: dirs.index, logger })
  const registry = createRepoRegistry({ config, save: () => saveConfig(home, config), logger, cbm })

  const server = createBaizeServer({ logger, registry, uiDist })
  const bridge = createAcpBridge({
    server,
    home,
    agentCommand: config.agentCommand ?? 'omp',
    logger,
  })

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
    bridge,
    async stop() {
      logger.info('shutting down')
      // Agent children first: their exit closes the /acp sockets, so the
      // server close below cannot hang on a live WebSocket connection
      // (server.close() waits for every connection, upgraded ones included).
      await bridge.stop()
      await close(server)
      await cbm.stop()
    },
  }
}
