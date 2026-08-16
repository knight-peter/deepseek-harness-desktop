/**
 * Engine smoke test (Phase 2): boot the installed engine exactly like the
 * shell does — Electron binary as plain Node (ELECTRON_RUN_AS_NODE=1) with
 * `--expose-internals` — then assert the URL line, HTTP 200 with the
 * `__DSH_BOOT__` injection, and a clean SIGTERM shutdown with no leftovers.
 * @module dsh-desktop/smoke
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const electronBin = require('electron')

const URL_LINE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/

function resolveBin() {
  if (process.env.DSH_ENGINE_BIN !== undefined) return process.env.DSH_ENGINE_BIN
  const packaged = join(ROOT, 'resources', 'engine', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(packaged)) return packaged
  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined) {
    const dev = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(dev)) return dev
  }
  throw new Error('no engine found: set DSH_ENGINE_BIN/DSH_CHECKOUT or run pnpm install-engine')
}

function fail(message) {
  console.error(`smoke: FAIL — ${message}`)
  process.exit(1)
}

async function main() {
  const bin = resolveBin()
  console.log(`smoke: engine bin = ${bin}`)
  const child = spawn(electronBin, ['--expose-internals', bin, '--profile', 'web', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  // Wait for the URL line (60s).
  const url = await new Promise((resolveUrl, reject) => {
    const deadline = Date.now() + 60_000
    const timer = setInterval(() => {
      const match = URL_LINE.exec(stdout)
      if (match !== null) { clearInterval(timer); resolveUrl(match[1]) }
      else if (child.exitCode !== null) { clearInterval(timer); reject(new Error(`engine exited early (code ${child.exitCode}):\n${stderr.slice(-2000)}`)) }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('timed out waiting for the URL line')) }
    }, 200)
  })
  console.log(`smoke: engine URL = ${url}`)

  // Health check: HTTP 200 + __DSH_BOOT__ injection.
  const response = await fetch(url)
  const body = await response.text()
  if (!response.ok) fail(`GET / returned HTTP ${response.status}`)
  if (!body.includes('__DSH_BOOT__')) fail('page misses the __DSH_BOOT__ injection')
  console.log('smoke: health check passed (HTTP 200 + __DSH_BOOT__)')

  // Graceful shutdown: SIGTERM, wait up to 10s, then SIGKILL.
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((r) => child.once('exit', (code, signal) => r({ code, signal }))),
    new Promise((r) => setTimeout(() => r(null), 10_000)),
  ])
  if (exited === null) {
    child.kill('SIGKILL')
    fail('engine did not exit within 10s of SIGTERM')
  }
  if (exited.code !== 0 && exited.signal !== 'SIGTERM') {
    fail(`unexpected exit: code=${String(exited.code)} signal=${String(exited.signal)}`)
  }
  console.log(`smoke: clean shutdown (code=${String(exited.code)} signal=${String(exited.signal)})`)
  console.log('smoke: PASS')
}

main().catch((error) => fail(String(error)))
