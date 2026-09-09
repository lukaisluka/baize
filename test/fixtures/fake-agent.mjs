#!/usr/bin/env node
// Fake ACP agent for bridge tests: line-delimited JSON-RPC on stdio.
// Commands: "initialize" -> canned agentInfo; "ping" -> pong with env probe
// (checks OTEL_* scrubbing); "noise" -> prints a non-JSON stdout line first;
// "die" -> exits 1 (tests child-exit -> socket-close teardown).
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const say = (line) => process.stdout.write(`${line}\n`)
// Pending session/request_permission answers, keyed by the request id.
const permissionWaiters = new Map()
// A prompt containing "slow-bleed" never answers on its own; on
// session/cancel it flushes a late chunk + idle AFTER a delay — simulating
// a cancelled turn whose updates trail the cancellation (benchmark turn
// attribution test).
let slowBleed = null
const cancelDelay = (ms, fn) => setTimeout(fn, ms)

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-agent', title: 'Fake Agent' } } })
  } else if (msg.method === 'ping') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { pong: true, otelLeaked: Object.keys(process.env).filter((k) => k.startsWith('OTEL_')) },
    })
  } else if (msg.method === 'noise') {
    say('THIS IS NOT JSON and must be dropped by the bridge')
    send({ jsonrpc: '2.0', id: msg.id, result: { noisy: true } })
  } else if (msg.method === 'die') {
    send({ jsonrpc: '2.0', id: msg.id, result: { dying: true } })
    setTimeout(() => process.exit(1), 50)
  } else if (msg.method === 'session/cancel') {
    if (slowBleed) {
      const dead = slowBleed
      slowBleed = null
      cancelDelay(400, () => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: dead.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE-BLEED' } } } })
        cancelDelay(100, () => {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: dead.params.sessionId, update: { sessionUpdate: 'status_changed', status: 'idle' } } })
        })
      })
    }
  } else if (msg.method === 'echo-params' || msg.method === 'session/new' || msg.method === 'session/load' || msg.method === 'session/resume' || msg.method === 'session/prompt') {
    // Reflects the exact params the bridge delivered (MCP injection tests);
    // session/* are the methods the bridge actually injects into.
    const promptText = msg.params?.prompt?.map((p) => p?.text ?? '').join('') ?? ''
    if (msg.method === 'session/prompt' && promptText.includes('slow-bleed')) {
      slowBleed = msg
      return
    }
    if (msg.method === 'session/prompt' && promptText.includes('needs-permission')) {
      // ACP permission round-trip: ask, wait for the client's answer, echo
      // the chosen optionId back in the turn's answer.
      const reqId = `perm-${msg.id}`
      const options = [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ]
      permissionWaiters.set(reqId, (outcome) => {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission outcome: ${outcome.outcome}:${outcome.optionId ?? ''}` } } } })
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: {} } })
      })
      send({ jsonrpc: '2.0', id: reqId, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, toolCall: { toolCallId: 'perm-tool', title: 'run thing', kind: 'execute', rawInput: {} }, options } })
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { params: msg.params } })
  } else if (msg.method === undefined && msg.id !== undefined && permissionWaiters.has(String(msg.id))) {
    // The client's answer to our session/request_permission (a response has
    // no method field).
    const waiter = permissionWaiters.get(String(msg.id))
    permissionWaiters.delete(String(msg.id))
    waiter(msg.result?.outcome ?? { outcome: 'missing' })
  } else if (msg.method === 'split') {
    // One write carrying a full message plus half of the next, remainder in a
    // later write — the bridge must reassemble lines across TCP read chunks.
    const first = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { split: 1 } })
    const second = JSON.stringify({ jsonrpc: '2.0', method: 'split/notification', params: { half: true } })
    process.stdout.write(`${first}\n${second.slice(0, 20)}`)
    setTimeout(() => process.stdout.write(`${second.slice(20)}\n`), 100)
  }
})
