import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Defaults are forward-shaped for the fleet work (#11, #12): gitlab.baseUrl /
// gitlab.token carry the PAT once the settings UI exists; repos will map
// repo path -> { branch } overrides. Keys nobody has set yet stay null/empty.
export const DEFAULT_CONFIG = Object.freeze({
  port: 0,
  openBrowser: true,
  pollIntervalMinutes: 15,
  gitlab: { baseUrl: null, token: null },
  repos: {},
})

function copyDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

export function configPath(home) {
  return join(home, 'config.json')
}

// Load ~/.baize/config.json, creating it with defaults (mode 0600 — the file
// will hold the GitLab PAT, PRD §7.2) when absent. Existing user values win;
// top-level defaults fill in keys an older config doesn't know about.
// A malformed file throws naming the path — never silently regenerated.
export function loadConfig(home) {
  const file = configPath(home)

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(copyDefaults(), null, 2)}\n`, { mode: 0o600 })
    return copyDefaults()
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`invalid config file ${file}: ${err.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid config file ${file}: expected a JSON object`)
  }

  // Enforce the 0600 invariant even for hand-created files; the PAT lands here.
  chmodSync(file, 0o600)

  return { ...copyDefaults(), ...parsed }
}
