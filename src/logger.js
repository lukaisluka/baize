import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// Plain append-only file log: startup/bind/request/shutdown events make a
// user-reported regression diagnosable from ~/.baize/logs/baize.log alone.
// No redaction here by design — nothing in this process logs config values
// (the PAT must never reach logs, PRD §7.2).
export function createLogger(logsDir) {
  const file = join(logsDir, 'baize.log')
  const write = (level, msg) => {
    appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}\n`)
  }
  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    file,
  }
}
