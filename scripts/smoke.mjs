/**
 * Engine smoke test (Phase 2): boot the installed engine exactly like the
 * shell does — Electron binary as plain Node (ELECTRON_RUN_AS_NODE=1) with
 * `--expose-internals` — then assert the URL line, HTTP 200 with the
 * `__DSH_BOOT__` injection, and a clean SIGTERM shutdown with no leftovers.
 *
 * The spawn contract itself lives in `engine-boot-check.mjs` (shared with the
 * installer's pre-swap boot gate); this script adds the end-to-end assertions.
 * `DSH_ELECTRON_BIN` picks the runtime, `DSH_ENGINE_BIN` the engine.
 * @module dsh-desktop/smoke
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineBoot, originOfUrl, waitForHealthyPage } from './engine-boot-check.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** How long the engine gets to print its URL line. */
const URL_TIMEOUT_MS = 60_000
/** How long the engine gets to answer `GET /` with the `__DSH_BOOT__` page. */
const HEALTH_TIMEOUT_MS = 30_000
/** How long the engine gets to exit after SIGTERM. */
const SHUTDOWN_TIMEOUT_MS = 10_000

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

/**
 * Health check: HTTP 200 + `__DSH_BOOT__` injection (plus the 0.1.5 token
 * redirect dance) — the same assertion the installer's pre-swap gate makes,
 * shared through `engine-boot-check.mjs`.
 *
 * Throws instead of exiting so the caller's `finally` still tears the engine
 * down; a failed check must not orphan a `dsh web` process.
 */
async function assertHealthy(url) {
  const page = await waitForHealthyPage(url, HEALTH_TIMEOUT_MS)
  if (!page.ok) throw new Error(page.reason)
}

async function main() {
  const bin = resolveBin()
  console.log(`smoke: engine bin = ${bin}`)
  const boot = new EngineBoot({ dshBin: bin })
  console.log(`smoke: runtime = ${boot.runtimeBin}`)

  // Always tear the engine down: a failed assertion must not leave an orphan
  // `dsh web` behind on the machine running the check.
  let failure = null
  let exited = null
  try {
    const url = await boot.waitForUrl(URL_TIMEOUT_MS)
    // Log the origin only. Engine ≥ 0.1.5 puts a `?token=…` credential in this
    // URL; CI logs are retained and the token grants full UI access to whoever
    // holds it (it exchanges for a 30-day session cookie). The path/query is
    // never needed to diagnose a smoke failure — the origin identifies the run.
    console.log(`smoke: engine URL = ${originOfUrl(url)}`)
    await assertHealthy(url)
    console.log('smoke: health check passed (HTTP 200 + __DSH_BOOT__)')
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    exited = await boot.stop(SHUTDOWN_TIMEOUT_MS)
  }

  if (failure !== null) fail(failure)
  if (exited === null) fail(`engine did not exit within ${SHUTDOWN_TIMEOUT_MS / 1000}s of SIGTERM`)
  if (exited.code !== 0 && exited.signal !== 'SIGTERM') {
    fail(`unexpected exit: code=${String(exited.code)} signal=${String(exited.signal)}`)
  }
  console.log(`smoke: clean shutdown (code=${String(exited.code)} signal=${String(exited.signal)})`)
  console.log('smoke: PASS')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
