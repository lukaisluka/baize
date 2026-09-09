import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The agent's working directory (~/.baize/agent) is the "project" OMP starts
// in. Before each connection baize lays out an AGENTS.md there (#10) — the
// fleet listing plus the citation rule — and hands the CBM MCP server to the
// agent through the ACP `session/new` mcpServers channel (see acp-bridge.js:
// OMP's ACP mode does not load a project .omp/mcp.json, verified live, so
// the wire channel is the single wiring mechanism).

export const CBM_SERVER_NAME = 'codebase-memory'

/**
 * The CBM server in ACP's mcpServer shape (env is a name/value ARRAY — the
 * ACP wire form, distinct from OMP's own config-file object form; passing an
 * object makes OMP throw "{} is not iterable").
 */
export function cbmMcpServer({ binaryPath, cacheDir }) {
  return {
    name: CBM_SERVER_NAME,
    command: binaryPath,
    args: ['--ui=false'],
    // Same cache dir as baize's own supervisor → the per-account CBM daemon
    // is shared, so the index baize built is what the agent sees.
    env: [{ name: 'CBM_CACHE_DIR', value: cacheDir }],
  }
}

function agentsMarkdown(repos) {
  const rows = Object.entries(repos)
    .map(([name, entry]) => `| ${name} | ${entry.path} | ${(entry.lastIndexedRevision ?? '').slice(0, 10) || 'not yet'} |`)
    .join('\n')
  const listing = rows
    ? `| project (index name) | worktree at indexed revision | indexed @ |\n| --- | --- | --- |\n${rows}`
    : '_No repositories indexed yet._'
  return `# BaiZe fleet workspace

You are running inside BaiZe. Repositories from the user's GitLab fleet are
mirrored and indexed for you; the \`codebase-memory\` MCP server (tools named
\`mcp__codebase-memory__*\`) is a prebuilt code graph over them.

${listing}

Rules for answering code questions:

- Use the index (search_graph, search_code, get_code_snippet, trace_path)
  instead of answering from memory — the index reflects the exact indexed
  revision. Read files under the listed worktree paths for verbatim text.
- Every factual claim about the code carries a citation of the form
  \`<project>/<path>:<line>\` (plus the symbol name where one exists).
- If the index has nothing relevant, say so explicitly instead of guessing.
`
}

/**
 * Idempotently lays out the agent workspace (the AGENTS.md listing). Returns
 * the written path. Pure writes — safe to run before every connection.
 */
export function prepareAgentWorkspace({ agentDir, repos }) {
  mkdirSync(agentDir, { recursive: true })
  const agentsPath = join(agentDir, 'AGENTS.md')
  writeFileSync(agentsPath, agentsMarkdown(repos ?? {}))
  return { agentsPath }
}
