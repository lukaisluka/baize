import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cbmMcpServer, prepareAgentWorkspace } from '../src/agent-workspace.js'

const work = mkdtempSync(join(tmpdir(), 'baize-agent-ws-'))

test.after(() => rmSync(work, { recursive: true, force: true }))

test('cbmMcpServer uses the ACP wire shape: env is a name/value array', () => {
  const server = cbmMcpServer({ binaryPath: '/opt/cbm/codebase-memory-mcp', cacheDir: '/idx' })
  // ACP's session/new mcpServers expects env: [{ name, value }] — an object
  // here makes OMP throw "{} is not iterable" (verified live).
  assert.deepEqual(server, {
    name: 'codebase-memory',
    command: '/opt/cbm/codebase-memory-mcp',
    args: ['--ui=false'],
    env: [{ name: 'CBM_CACHE_DIR', value: '/idx' }],
  })
})

test('AGENTS.md lists the fleet with revisions and the citation rule', () => {
  const agentDir = join(work, 'agents-md')
  const { agentsPath } = prepareAgentWorkspace({
    agentDir,
    repos: {
      'grp/alpha': { path: '/wt/alpha', lastIndexedRevision: 'abcdef1234'.repeat(4) },
      manual: { path: '/x/manual' },
    },
  })
  const md = readFileSync(agentsPath, 'utf8')
  assert.match(md, /grp\/alpha/)
  assert.match(md, /\/wt\/alpha/)
  assert.match(md, /abcdef1234/)
  assert.match(md, /mcp__codebase-memory__/)
  assert.match(md, /citation/i)
  assert.match(md, /not yet/, 'unindexed entries are visible too')
})

test('an empty fleet still gets a workspace (explicit empty listing)', () => {
  const agentDir = join(work, 'empty')
  const { agentsPath } = prepareAgentWorkspace({ agentDir, repos: {} })
  const md = readFileSync(agentsPath, 'utf8')
  assert.match(md, /No repositories indexed yet/)
  assert.match(md, /codebase-memory/, 'the tool guidance is still there')
})
