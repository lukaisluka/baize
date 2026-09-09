import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// BAIZE_HOME lets tests and smoke runs redirect the data dir; production
// always uses ~/.baize (PRD §6.2).
export function resolveHome(env = process.env) {
  return env.BAIZE_HOME || join(homedir(), '.baize')
}

// The ~/.baize layout from PRD §6.2. Safe to run on every start: missing
// entries are created, existing ones left untouched.
export function ensureDataLayout(home) {
  const dirs = {
    root: home,
    repos: join(home, 'repos'),
    index: join(home, 'index'),
    logs: join(home, 'logs'),
  }
  mkdirSync(dirs.repos, { recursive: true })
  mkdirSync(dirs.index, { recursive: true })
  mkdirSync(dirs.logs, { recursive: true })
  return dirs
}
