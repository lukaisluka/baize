import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { CbmSupervisor } from '../src/cbm.js'

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.exitCode = null
    this.stdin = new EventEmitter()
    this.stdin.written = []
    this.stdin.write = (line) => this.stdin.written.push(line)
    this.stdout = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr = new EventEmitter()
    this.stderr.setEncoding = () => {}
    this.killed = []
  }
  kill(signal) {
    this.killed.push(signal)
    this.exitCode = this.exitCode ?? 0
    this.emit('exit', this.exitCode, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM')
  }
  stdoutLine(obj) {
    this.stdout.emit('data', `${JSON.stringify(obj)}\n`)
  }
  request(i) {
    const line = this.stdin.written[i]
    return line ? JSON.parse(line) : undefined
  }
  // Reply to the i-th request by echoing its actual id — robust against the
  // supervisor's internal id allocation changing.
  reply(i, result) {
    this.stdoutLine({ jsonrpc: '2.0', id: this.request(i).id, result })
  }
}

function makeSupervisor() {
  const children = []
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const cbm = new CbmSupervisor({
    binaryPath: '/fake/cbm',
    cacheDir: '/fake/cache',
    logger,
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  return { cbm, children }
}

const handshakeResult = {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'codebase-memory-mcp', version: '0.10.8' },
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test(
  'handshake: initialize, initialized notification, then tools/call',
  { timeout: 10000 },
  async () => {
    const { cbm, children } = makeSupervisor()
    const callPromise = cbm.call('list_projects', {})

    const child = children[0]
    assert.equal(child.request(0).method, 'initialize')
    assert.equal(child.request(0).params.clientInfo.name, 'baize')
    child.reply(0, handshakeResult)
    await settle()
    assert.equal(child.request(1).method, 'notifications/initialized')

    assert.equal(child.request(2).method, 'tools/call')
    assert.equal(child.request(2).params.name, 'list_projects')
    child.reply(2, { structuredContent: { projects: [{ name: 'x' }] }, isError: false })
    assert.deepEqual(await callPromise, { projects: [{ name: 'x' }] })
  },
)

test('isError tool results reject with the structured error', { timeout: 10000 }, async () => {
  const { cbm, children } = makeSupervisor()
  const promise = cbm.call('index_status', { project: 'nope' })
  const child = children[0]
  child.reply(0, handshakeResult)
  await settle()
  child.reply(2, { structuredContent: { error: 'project not found' }, isError: true })
  await assert.rejects(promise, /index_status: project not found/)
})

test('call timeout rejects without killing the child', { timeout: 10000 }, async () => {
  const { cbm, children } = makeSupervisor()
  const promise = cbm.call('list_projects', {}, { timeoutMs: 10 })
  const child = children[0]
  child.reply(0, handshakeResult)
  await assert.rejects(promise, /timed out after 10ms/)
  assert.equal(child.killed.length, 0)
})

test('unexpected exit rejects pending calls and restarts on next use', { timeout: 10000 }, async () => {
  const { cbm, children } = makeSupervisor()
  const promise = cbm.call('list_projects', {})
  const child = children[0]
  child.reply(0, handshakeResult)
  await settle()
  // Real Node sets exitCode before emitting 'exit'; mirror that.
  child.exitCode = 1
  child.emit('exit', 1, 'SIGSEGV')

  await assert.rejects(promise, /exited \(code 1|exited before send|exited during handshake/)

  // Next call lazily spawns a fresh child and redoes the handshake.
  const retry = cbm.call('list_projects', {})
  const second = children[1]
  second.reply(0, handshakeResult)
  await settle()
  second.reply(2, { structuredContent: { ok: true } })
  assert.deepEqual(await retry, { ok: true })
})

test('stop(): SIGTERM child, then daemon stop; exit path tolerates already-dead child', { timeout: 10000 }, async () => {
  const { cbm, children } = makeSupervisor()
  const ready = cbm.ensure()
  const child = children[0]
  child.reply(0, handshakeResult)
  await ready

  await cbm.stop()
  assert.deepEqual(child.killed, ['SIGTERM'])
  // A second stop with no live child must not throw.
  await cbm.stop()
})

test('unparseable stdout lines are warned, not fatal', { timeout: 10000 }, async () => {
  const warnings = []
  const children = []
  const cbm = new CbmSupervisor({
    binaryPath: '/fake/cbm',
    cacheDir: '/c',
    logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    spawnImpl: () => {
      const child = new FakeChild()
      children.push(child)
      return child
    },
  })
  const promise = cbm.call('list_projects', {})
  const child = children[0]
  child.stdout.emit('data', 'this is not json\n')
  child.reply(0, handshakeResult)
  await settle()
  child.reply(2, { structuredContent: { ok: 1 } })
  assert.deepEqual(await promise, { ok: 1 })
  assert.ok(warnings.some((m) => m.includes('unparseable')))
})
