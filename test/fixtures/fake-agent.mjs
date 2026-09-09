#!/usr/bin/env node
// Fake ACP agent for bridge tests: line-delimited JSON-RPC on stdio.
// Commands: "initialize" -> canned agentInfo; "ping" -> pong with env probe
// (checks OTEL_* scrubbing); "noise" -> prints a non-JSON stdout line first;
// "die" -> exits 1 (tests child-exit -> socket-close teardown).
import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const say = (line) => process.stdout.write(`${line}\n`)

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
  } else if (msg.method === 'echo-params' || msg.method === 'session/new' || msg.method === 'session/load' || msg.method === 'session/resume' || msg.method === 'session/prompt') {
    // Reflects the exact params the bridge delivered (MCP injection tests);
    // session/* are the methods the bridge actually injects into.
    send({ jsonrpc: '2.0', id: msg.id, result: { params: msg.params } })
  } else if (msg.method === 'split') {
    // One write carrying a full message plus half of the next, remainder in a
    // later write — the bridge must reassemble lines across TCP read chunks.
    const first = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { split: 1 } })
    const second = JSON.stringify({ jsonrpc: '2.0', method: 'split/notification', params: { half: true } })
    process.stdout.write(`${first}\n${second.slice(0, 20)}`)
    setTimeout(() => process.stdout.write(`${second.slice(20)}\n`), 100)
  }
})
