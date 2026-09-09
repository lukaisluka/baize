/**
 * Benchmark runner (#17): executes a dataset against a LIVE baize server
 * end-to-end — the same ACP-over-WebSocket path the chat UI uses
 * (initialize → session/new → session/prompt), with the bridge injecting
 * the CBM MCP server (src/acp-bridge.js). Per question it records the
 * answer text, every tool call (title, raw arguments, locations), the
 * extracted citations, and the fleet repos the turn actually touched.
 *
 * Results land as JSONL, one line per question, appended incrementally:
 * a long run can be Ctrl-C'd and re-invoked — successfully recorded ids
 * are skipped, errored ones (prompt timeouts) are retried.
 *
 * Human judgments are deliberately NOT the runner's: evidence validity and
 * repo recall are computed offline from the JSONL (report.js); the useful
 * rubric (PRD §15) is applied by reviewers into a sidecar file.
 */

import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { extractCitations, fleetNameFromCbm } from './dataset.js'

/** Folds one turn's session/update notifications into the result shape the
 * report consumes. Pure — unit-tested without a live agent. */
export function collectTurn(updates, repoNames) {
  let answer = ''
  const toolCalls = []
  for (const update of updates) {
    if (update?.sessionUpdate === 'agent_message_chunk') {
      answer += update.content?.text ?? ''
    } else if (update?.sessionUpdate === 'tool_call') {
      toolCalls.push({
        toolCallId: update.toolCallId,
        title: (update.title ?? '').split('\n')[0],
        rawInput: update.rawInput ?? null,
        locations: update.locations ?? [],
      })
    } else if (update?.sessionUpdate === 'tool_call_update') {
      const existing = toolCalls.find((t) => t.toolCallId === update.toolCallId)
      if (existing && Array.isArray(update.locations) && update.locations.length > 0) {
        existing.locations = update.locations
      }
    }
  }
  const citations = extractCitations(answer, repoNames)
  const toolRepos = toolCalls
    .map((call) => {
      const project = call.rawInput?.project
      return typeof project === 'string' ? fleetNameFromCbm(project, repoNames) : null
    })
    .filter(Boolean)
  const touchedRepos = [...new Set([...citations.map((c) => c.repo), ...toolRepos])]
  return { answer, toolCalls, citations, touchedRepos }
}

/** The ids already successfully recorded in an output file — the resume set.
 * Errored rows (e.g. a prompt timeout) are deliberately NOT resume-worthy: a
 * re-invocation retries them instead of locking the failure in. A corrupt
 * trailing line (a Ctrl-C mid-write) is skipped, not fatal. */
export function recordedIds(outPath) {
  if (!existsSync(outPath)) return new Set()
  const ids = new Set()
  for (const line of readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.id === 'string' && !entry.error) ids.add(entry.id)
    } catch {
      // Partial trailing line from an interrupted run.
    }
  }
  return ids
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`)
  return response.json()
}

/** Races a promise against a deadline, clearing the timer either way — a
 * settled race that leaves its setTimeout alive keeps the process (and the
 * next JSONL append) hanging for the full timeout. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Minimal ACP client: one request/response round-trip with notification
 * fan-out. `session/request_permission` from the agent is auto-approved
 * (first allow option) — a headless run that leaves a permission unanswered
 * deadlocks the turn until the prompt timeout, and the benchmark measures
 * the agent, not a stalled permission dialog. Kept local — the UI's client
 * is a React-facing port. */
function createAcpClient(wsUrl, onPermission) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  const updateListeners = []
  let nextId = 0
  const send = (msg) => ws.send(JSON.stringify(msg))
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if ((msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else if (msg.method === 'session/update') {
      for (const listener of updateListeners) listener(msg.params?.update)
    } else if (msg.method === 'session/request_permission') {
      const options = msg.params?.options ?? []
      const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      onPermission?.(msg.params?.toolCall?.title ?? msg.params?.toolCallId ?? 'unknown', allow?.name ?? null)
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: allow
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      })
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else resolve(msg.result)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
  return { ws, opened, request, notify, updateListeners }
}

/** Resolves when the agent reports status idle — the protocol-level "the
 * cancelled turn has fully flushed" marker. Updates that arrive before it
 * belong to the dead turn; collecting the next question's updates only
 * after it keeps turn attribution off the clock. `ms` caps the wait for
 * agents that never settle. */
function waitForIdle(client, ms) {
  return new Promise((resolve) => {
    const listener = (update) => {
      if (update?.sessionUpdate === 'status_changed' && update.status === 'idle') cleanup(true)
    }
    const timer = setTimeout(() => cleanup(false), ms)
    const cleanup = (idle) => {
      clearTimeout(timer)
      const index = client.updateListeners.indexOf(listener)
      if (index >= 0) client.updateListeners.splice(index, 1)
      resolve(idle)
    }
    client.updateListeners.push(listener)
  })
}

/**
 * Runs a dataset against the live server at `baseUrl` (e.g. http://127.0.0.1:8940).
 * Options: { out (required path), timeoutMs = 240_000, logger, cwd (session
 * working dir; agents require an absolute path) }. The default cwd is the
 * server's agent workspace (/api/repos → agentWorkspace): its AGENTS.md is
 * what tells the agent about the fleet and the CBM tools — any other cwd
 * (the UI's "/" or an empty scratch dir) leaves the agent without the
 * baize half of the contract and it will answer from an empty directory.
 * Appends one JSONL line per question.
 */
export async function runDataset({ baseUrl, dataset, out, timeoutMs = 240_000, cwd, logger }) {
  const log = logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  const fleet = await fetchJson(`${baseUrl}/api/repos`)
  const repoNames = fleet.repos.map((r) => r.name)
  log.info(`benchmark: fleet has ${repoNames.length} repos: ${repoNames.join(', ') || '(none)'}`)

  const ownsScratch = !cwd && !fleet.agentWorkspace
  const scratchDir = cwd ?? fleet.agentWorkspace ?? mkdtempSync(join(tmpdir(), 'baize-bench-cwd-'))
  if (cwd) log.info(`benchmark: session cwd is ${scratchDir}`)
  else if (fleet.agentWorkspace) log.info(`benchmark: session cwd is the server's agent workspace (${scratchDir})`)
  else log.warn(`benchmark: server did not report an agent workspace; using a fresh scratch dir (${scratchDir}) — the agent will lack the fleet AGENTS.md guidance`)

  const grantedPermissions = []
  const client = createAcpClient(`${baseUrl.replace(/\/$/, '')}/acp`, (title, option) => {
    grantedPermissions.push({ title, option })
    log.info(`benchmark: auto-approved permission "${title}" (${option ?? 'no allow option — cancelled'})`)
  })

  // Every append waits for its write callback; a failed stream must fail
  // them (fail fast), not hang them — disk-full would otherwise stall the
  // run silently.
  const pendingAppends = []
  let streamFailure = null
  let finished = false
  const stream = createWriteStream(out, { flags: 'a' })
  const failAppends = (err) => {
    if (finished) return
    streamFailure = err
    log.error(`benchmark: output stream: ${err.message}`)
    for (const reject of pendingAppends.splice(0)) reject(err)
  }
  stream.on('error', failAppends)
  stream.on('close', () => failAppends(new Error('output stream closed before completion')))
  const append = (line) =>
    new Promise((resolve, reject) => {
      if (streamFailure) return reject(streamFailure)
      pendingAppends.push(reject)
      stream.write(line, (err) => {
        const index = pendingAppends.indexOf(reject)
        if (index >= 0) pendingAppends.splice(index, 1)
        if (err) reject(err)
        else resolve()
      })
    })

  try {
    await client.opened
    await withTimeout(
      client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeFile: false } },
      }),
      30_000,
      'initialize timed out after 30000ms',
    )
    client.notify('notifications/initialized')
    const session = await withTimeout(
      client.request('session/new', { cwd: scratchDir, mcpServers: [] }),
      30_000,
      'session/new timed out after 30000ms',
    )

    const done = recordedIds(out)
    for (const question of dataset.questions) {
      if (done.has(question.id)) {
        log.info(`benchmark: skip ${question.id} (already recorded)`)
        continue
      }
      const updates = []
      const listener = (update) => updates.push(update)
      client.updateListeners.push(listener)
      const permissionsBefore = grantedPermissions.length
      const startedAt = Date.now()
      let stopReason = null
      let error = null
      try {
        const response = await withTimeout(
          client.request('session/prompt', {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: question.question }],
          }),
          timeoutMs,
          `prompt timed out after ${timeoutMs}ms`,
        )
        stopReason = response?.stopReason ?? null
      } catch (err) {
        error = err.message
        if (err.message.includes('timed out')) {
          // Stop the agent side of the dead turn, then hold THIS question's
          // listener until the agent reports idle — its late updates land in
          // this row, not the next question's.
          client.notify('session/cancel', { sessionId: session.sessionId })
          const idle = await waitForIdle(client, 5000)
          if (!idle) log.warn(`benchmark: ${question.id}: agent never went idle after cancel — late updates may bleed into the next question`)
        }
      }
      const elapsedMs = Date.now() - startedAt
      client.updateListeners.splice(client.updateListeners.indexOf(listener), 1)
      const turn = collectTurn(updates, repoNames)
      const entry = {
        dataset: dataset.name,
        id: question.id,
        category: question.category,
        question: question.question,
        answer: turn.answer,
        stopReason,
        error,
        elapsedMs,
        toolCalls: turn.toolCalls,
        citations: turn.citations,
        touchedRepos: turn.touchedRepos,
        permissionsGranted: grantedPermissions.slice(permissionsBefore),
      }
      await append(`${JSON.stringify(entry)}\n`)
      log.info(
        `benchmark: ${question.id} done in ${elapsedMs}ms (stop=${stopReason ?? error}, tools=${turn.toolCalls.length}, cites=${turn.citations.length})`,
      )
    }
  } finally {
    finished = true
    await new Promise((resolve, reject) => {
      if (streamFailure) reject(streamFailure)
      else stream.end(resolve)
    })
    client.ws.close()
    if (ownsScratch) rmSync(scratchDir, { recursive: true, force: true })
  }
  return { out }
}
