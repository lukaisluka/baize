import { ensureDataLayout, resolveHome } from './paths.js'
import { join } from 'node:path'
import { loadConfig, saveConfig } from './config.js'
import { createLogger } from './logger.js'
import { close, createBaizeServer, listen } from './server.js'
import { openBrowser } from './open-browser.js'
import { CbmSupervisor } from './cbm.js'
import { createRepoRegistry } from './repos.js'
import { createAcpBridge } from './acp-bridge.js'
import { prepareAgentWorkspace, cbmMcpServer } from './agent-workspace.js'
import { createGitLabService } from './gitlab.js'
import { createSyncEngine } from './sync.js'

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
  const gitlab = createGitLabService({ config, save: () => saveConfig(home, config), logger })
  // The #13 loop: sync lands a mirror on a new revision -> registry kicks an
  // incremental CBM index for it. Errors here must never take the sync cycle
  // down — they are logged and the next revision retries.
  const sync = createSyncEngine({
    home,
    config,
    save: () => saveConfig(home, config),
    gitlab,
    logger,
    onRevision: (name, revision, path) => {
      try {
        registry.ensureFleetRepo(name, path, revision)
      } catch (err) {
        logger.error(`fleet: registering mirror ${name} for indexing failed: ${err.message}`)
      }
    },
  })
  sync.start()

  const server = createBaizeServer({ logger, registry, gitlab, sync, uiDist })
  const bridge = createAcpBridge({
    server,
    home,
    agentCommand: config.agentCommand ?? 'omp',
    logger,
    // Fresh per connection: the fleet listing and CBM wiring must reflect the
    // repos indexed so far, and a moved binary path heals on the next chat.
    prepareWorkspace: () =>
      prepareAgentWorkspace({ agentDir: join(home, 'agent'), repos: config.repos ?? {} }),
    agentMcpServers: () => {
      const binaryPath = cbm.binaryPathOrNull()
      return binaryPath ? [cbmMcpServer({ binaryPath, cacheDir: dirs.index })] : []
    },
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
    sync,
    async stop() {
      logger.info('shutting down')
      // close(server) stops listening synchronously and resolves once every
      // connection is gone — upgraded sockets included. So: stop listening
      // first (no new /acp connections can spawn fresh children behind the
      // sweep), kill the agent children (their exit closes those sockets,
      // letting the close resolve — it would hang otherwise), then in-flight
      // git syncs, then CBM.
      const closed = close(server)
      await bridge.stop()
      await sync.stop()
      registry.stop()
      await closed
      await cbm.stop()
    },
  }
}
