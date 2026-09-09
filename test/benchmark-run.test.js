import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createAcpBridge } from '../src/acp-bridge.js'
import { collectTurn, recordedIds, runDataset } from '../src/benchmark/run.js'
import { loadDataset } from '../src/benchmark/dataset.js'
import { close, listen } from '../src/server.js'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-agent.mjs')

test('collectTurn folds updates into answer, tool calls, citations, touched repos', () => {
  const updates = [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it at ' } },
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'search graph', kind: 'other', rawInput: { project: 'grp-alpha', query: 'greet' }, locations: [] },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`grp/alpha/hello.js:1-3`.' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', locations: [{ path: '/wt/hello.js', line: 2 }] },
    { sessionUpdate: 'user_message', content: [{ type: 'text', text: 'ignored' }] },
  ]
  const turn = collectTurn(updates, ['grp/alpha', 'beta'])
  assert.equal(turn.answer, 'Found it at `grp/alpha/hello.js:1-3`.')
  assert.equal(turn.toolCalls.length, 1)
  assert.equal(turn.toolCalls[0].title, 'search graph')
  assert.deepEqual(turn.toolCalls[0].locations, [{ path: '/wt/hello.js', line: 2 }])
  assert.deepEqual(turn.citations.map((c) => c.raw), ['grp/alpha/hello.js:1-3'])
  // Touched = cited repo ∪ CBM project arg mapped back to fleet name.
  assert.deepEqual(turn.touchedRepos, ['grp/alpha'])
})

test('collectTurn tolerates malformed updates (never throws on a live turn)', () => {
  const turn = collectTurn([null, {}, { sessionUpdate: 'agent_message_chunk' }, { sessionUpdate: 'tool_call' }], [])
  assert.equal(turn.answer, '')
  assert.deepEqual(turn.touchedRepos, [])
})

test('recordedIds reads the resume set and survives a corrupt trailing line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baize-bench-'))
  try {
    const out = join(dir, 'run.jsonl')
    writeFileSync(
      out,
      '{"id":"q1"}\n{"id":"q2","error":"prompt timed out"}\n{"id":"q3"',
    )
    // Errored rows are retried on the next invocation, not skipped.
    assert.deepEqual([...recordedIds(out)].sort(), ['q1'])
    assert.deepEqual([...recordedIds(join(dir, 'absent.jsonl'))], [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A timed-out turn is cancelled; the agent's late flush (chunk + idle) must
// land in the timed-out row, never bleed into the next question's answer.
test('a cancelled turn keeps its late updates to itself', { timeout: 20000 }, async () => {
  const agentWs = mkdtempSync(join(tmpdir(), 'baize-bench-ws-'))
  const server = createServer((req, res) => {
    if (req.url === '/api/repos') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ repos: [], agentWorkspace: agentWs }))
      return
    }
    res.writeHead(404).end()
  })
  const home = mkdtempSync(join(tmpdir(), 'baize-bench-home-'))
  const bridge = createAcpBridge({ server, home, agentCommand: `node ${FAKE}` })
  const bound = await listen(server, { port: 0 })
  const dir = mkdtempSync(join(tmpdir(), 'baize-bench-out-'))
  const out = join(dir, 'run.jsonl')
  const dataset = loadDataset(
    JSON.stringify({
      name: 'bleed',
      questions: [
        { id: 'q-slow', category: 'ambiguous-debugging', question: 'slow-bleed: never answers', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
        { id: 'q-fast', category: 'code-location', question: 'where?', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
      ],
    }),
  )
  try {
    await runDataset({ baseUrl: `http://${bound.host}:${bound.port}`, dataset, out, timeoutMs: 500 })
    const entries = readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    assert.match(entries[0].error, /timed out/)
    // The cancelled turn's late chunk belongs to the row that timed out…
    assert.match(entries[0].answer, /LATE-BLEED/)
    // …and the next question stays clean.
    assert.equal(entries[1].error, null)
    assert.ok(!entries[1].answer.includes('LATE-BLEED'), `bled: ${entries[1].answer}`)
  } finally {
    await bridge.stop()
    await close(server)
    rmSync(home, { recursive: true, force: true })
    rmSync(agentWs, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

// End-to-end through the real bridge against the fake ACP agent: the runner's
// wire sequence (initialize → session/new → session/prompt) must produce one
// JSONL line per question, auto-approve the agent's permission requests, and
// be resumable.
test('runDataset executes a dataset end-to-end and resumes from existing output', { timeout: 20000 }, async () => {
  const repos = [{ name: 'grp/alpha', path: '/wt/alpha', status: 'ready' }]
  // The server-reported agent workspace: the runner must use it as the
  // session cwd (AGENTS.md contract) and must NOT delete it afterwards.
  const agentWs = mkdtempSync(join(tmpdir(), 'baize-bench-ws-'))
  const server = createServer((req, res) => {
    if (req.url === '/api/repos') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ repos, agentWorkspace: agentWs }))
      return
    }
    res.writeHead(404).end()
  })
  const home = mkdtempSync(join(tmpdir(), 'baize-bench-home-'))
  const bridge = createAcpBridge({ server, home, agentCommand: `node ${FAKE}` })
  const bound = await listen(server, { port: 0 })
  const dir = mkdtempSync(join(tmpdir(), 'baize-bench-out-'))
  const out = join(dir, 'run.jsonl')
  const dataset = loadDataset(
    JSON.stringify({
      name: 'mini',
      questions: [
        { id: 'q1', category: 'code-location', question: 'where?', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
        { id: 'q2', category: 'architecture', question: 'needs-permission: run the thing', expected: { answer: '', evidence: [], reviewed: false }, relevantRepos: ['grp/alpha'] },
      ],
    }),
  )
  const readEntries = () =>
    readFileSync(out, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  try {
    await runDataset({ baseUrl: `http://${bound.host}:${bound.port}`, dataset, out })
    const entries = readEntries()
    assert.deepEqual(entries.map((e) => e.id), ['q1', 'q2'], 'one JSONL line per question')
    // The permission round-trip: the runner answered (auto-approve picked the
    // allow option), and the grant is recorded on the entry.
    assert.equal(entries[1].answer, 'permission outcome: selected:allow')
    assert.deepEqual(entries[1].permissionsGranted, [{ title: 'run thing', option: 'Allow' }])

    // Second invocation skips both — nothing new is appended.
    await runDataset({ baseUrl: `http://${bound.host}:${bound.port}`, dataset, out })
    assert.deepEqual(readEntries().map((e) => e.id), ['q1', 'q2'], 'resume skips recorded ids')
  } finally {
    await bridge.stop()
    await close(server)
    assert.ok(existsSync(agentWs), 'the server-owned agent workspace must survive the run')
    rmSync(home, { recursive: true, force: true })
    rmSync(agentWs, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
