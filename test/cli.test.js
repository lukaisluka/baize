import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { cleanupHome, tempHome } from './helpers.js'

const CLI = new URL('../src/cli.js', import.meta.url).pathname

function runCli(args, { home }) {
  return spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, BAIZE_HOME: home, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function collect(child) {
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  return { getOut: () => out, getErr: () => err }
}

test('--version and --help exit 0 without touching the network', async () => {
  const home = tempHome()
  try {
    for (const flag of ['--version', '--help']) {
      const child = runCli([flag], { home })
      const { getOut } = collect(child)
      const code = await exitCode(child)
      assert.equal(code, 0, `${flag} exits 0`)
      assert.ok(getOut().length > 0, `${flag} prints something`)
    }
  } finally {
    cleanupHome(home)
  }
})

test('baize serves the page and exits 0 on SIGINT (clean Ctrl-C)', async () => {
  const home = tempHome()
  const child = runCli(['--no-open'], { home })
  const { getOut } = collect(child)
  try {
    const firstLine = await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve)
      child.once('exit', reject)
      setTimeout(() => reject(new Error(`no output; stderr so far: ${child.stderr.read()}`)), 5000)
    })
    const match = /BaiZe running at (http:\/\/127\.0\.0\.1:\d+)/.exec(firstLine.toString())
    assert.ok(match, `startup line announces the URL, got: ${firstLine}`)

    const res = await fetch(match[1])
    assert.equal(res.status, 200)
    assert.match(await res.text(), /BaiZe/)
  } finally {
    child.kill('SIGINT')
    assert.equal(await exitCode(child), 0, 'SIGINT exits cleanly with status 0')
    assert.ok(!/Error/.test(getOut()), 'no error output on shutdown')
    cleanupHome(home)
  }
})

test('invalid --port fails fast with a clear message', async () => {
  const home = tempHome()
  try {
    const child = runCli(['--port', 'not-a-port'], { home })
    const { getErr } = collect(child)
    assert.equal(await exitCode(child), 1)
    assert.match(getErr(), /invalid port/)
  } finally {
    cleanupHome(home)
  }
})

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)))
}

const exitCode = (child) => once(child, 'close').then(([code]) => code)
