import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Fresh BAIZE_HOME per test so nothing ever touches the real ~/.baize.
export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'baize-test-'))
}

export function cleanupHome(home) {
  rmSync(home, { recursive: true, force: true })
}
