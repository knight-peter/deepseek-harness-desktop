/**
 * Engine boot check: spawn `dsh web` exactly the way the shell does, and wait
 * for the URL line the engine prints once its server binds.
 *
 * Why this exists (2026-10-01 实测): `@deepseek-ai/dsh` ≥ 0.1.6-alpha.1 boots
 * its profile resolution through the prebuilt `node-addon-require-builtin`
 * addon (`@deepseek-ai/dsh-app-boot`, upstream commit `6aa2e4633c`). That
 * native binary only accepts an **exact V8 fingerprint allowlist** — Electron
 * 43.0.0 / 44.0.0 / 45.0.0-alpha.6 when this was written. Any other Electron
 * build (e.g. 43.4.0: V8 15.0.245.28 vs the allowed 15.0.245.13) makes the
 * engine die during boot with
 * `node-addon-require-builtin unsupported: Unsupported/no-context`.
 *
 * Such an engine installs perfectly from npm and only fails at startup, so the
 * installer must boot the *staged* tree under the real runtime before swapping
 * it in: a fingerprint mismatch then becomes a refused update that keeps the
 * working engine, instead of an app that cannot start.
 *
 * Shared by `install-engine.mjs` (the pre-swap gate) and `smoke.mjs` (the full
 * health check) so the spawn contract lives in one place. `src/main/harness.ts`
 * is the third caller; it cannot import this module (it is compiled into the
 * asar without the scripts tree), so keep the argument list and `URL_LINE` in
 * sync with it.
 * @module dsh-desktop/engine-boot-check
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The line `dsh web` prints once the server binds. The whole URL is captured:
 * since 0.1.5 the query carries a per-boot `?token=` credential that must not
 * be truncated (it exchanges for the session cookie — see harness.ts).
 */
export const URL_LINE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+[^\s]*)/

/** Engine stderr lines kept for diagnostics when a boot fails. */
const STDERR_TAIL_LINES = 40

/**
 * Absolute path of the Electron binary the engine is hosted by.
 *
 * Order: `DSH_ELECTRON_BIN` override (tests / cross-checking another Electron
 * build), then the running binary whenever *we* are an Electron runtime
 * (packaged app, and every `ELECTRON_RUN_AS_NODE` child — that IS the host the
 * engine will get), then the workspace devDependency for `node scripts/…`.
 */
export function engineRuntimeBin() {
  const override = process.env.DSH_ELECTRON_BIN
  if (override !== undefined && override !== '') return override
  if (process.versions.electron !== undefined) return process.execPath
  // Dev/CI: electron's main entry is a path string. A missing download throws
  // here on purpose — that is a broken checkout, not something to paper over.
  const require = createRequire(import.meta.url)
  return require('electron')
}

/**
 * Arguments every engine launch uses. `--expose-internals` is required: it is
 * what makes the vendored loader use its plain `require` fallback under
 * Electron-as-node (see docs/Electron基座应用开发.md §2.1). `--no-open` keeps
 * the engine from popping the system browser; the shell has its own window.
 * `extraArgs` are launcher-level CLI options (e.g. `--patch <overlay>`). They
 * MUST sit after `--profile web` and before `--port`/`--no-open`: those two
 * are app-args, and the CLI stops recognizing launcher options once the
 * app-arg section starts (`error: unknown option '--patch'` otherwise).
 */
export function engineArgs(dshBin, extraArgs = []) {
  return ['--expose-internals', dshBin, '--profile', 'web', ...extraArgs, '--port', '0', '--no-open']
}

/** Mask the engine's per-boot `?token=` credential in anything loggable. */
export function redactToken(text) {
  return text.replace(/([?&]token=)[^\s&"']+/gi, '$1<redacted>')
}

/** Origin (`scheme://host:port`) of a URL — the token-free part. */
export function originOfUrl(url) {
  try {
    return new URL(url).origin
  } catch {
    return '(unparseable engine url)'
  }
}

/**
 * Scratch `$DSH_HOME` for a boot check: a gate run must never read or write the
 * user's real profile (no side effects, no interference with a running app).
 * The engine creates `profiles/web` itself, so an empty home is bootable.
 */
export function createTempDshHome(prefix = 'dsh-engine-boot-') {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return {
    path,
    cleanup() {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // best effort: a leftover temp dir must never fail an install
      }
    },
  }
}

/**
 * One engine process, booted the way the shell boots it.
 *
 * @example
 * const boot = new EngineBoot({ dshBin, home: scratch.path })
 * const url = await boot.waitForUrl(60_000)   // throws with stderr tail
 * await boot.stop()
 */
export class EngineBoot {
  #child
  #url = null
  #out = ''
  #err = ''
  #pending = { stdout: '', stderr: '' }
  #exited = null

  /**
   * @param options.dshBin absolute path to the engine's `lib/bin.js`
   * @param options.runtimeBin Electron binary (default: `engineRuntimeBin()`)
   * @param options.cwd working directory (default: the user's home)
   * @param options.home `$DSH_HOME` for the child (default: inherit)
   * @param options.env extra environment merged over the current one
   * @param options.args launcher-level CLI arguments appended after the
   *   fixed list (e.g. `['--patch', overlayPath]`); not Node flags
   */
  constructor(options) {
    // Absolute paths: the child gets its own `cwd`, and a relative command
    // would be resolved against that cwd (posix_spawn chdirs first), not ours.
    const runtimeBin = resolve(options.runtimeBin ?? engineRuntimeBin())
    const dshBin = resolve(options.dshBin)
    if (!existsSync(dshBin)) throw new Error(`engine boot: dsh bin not found: ${dshBin}`)
    if (!existsSync(runtimeBin)) throw new Error(`engine boot: Electron runtime not found: ${runtimeBin}`)
    this.runtimeBin = runtimeBin
    this.dshBin = dshBin
    this.#child = spawn(runtimeBin, engineArgs(dshBin, options.args ?? []), {
      cwd: options.cwd ?? homedir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(options.home === undefined ? {} : { DSH_HOME: options.home }),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stderr.setEncoding('utf8')
    this.#child.stdout.on('data', (chunk) => this.#onOutput(chunk, 'stdout'))
    this.#child.stderr.on('data', (chunk) => this.#onOutput(chunk, 'stderr'))
    this.#child.on('exit', (code, signal) => { this.#exited = { code, signal } })
    this.#child.on('error', (error) => {
      this.#err += `${String(error)}\n`
      this.#exited = { code: null, signal: null }
    })
  }

  get child() {
    return this.#child
  }

  /** Engine stdout so far (token-redacted). */
  get stdout() {
    return redactToken(this.#out)
  }

  /** Engine stderr so far (token-redacted). */
  get stderr() {
    return redactToken(this.#err)
  }

  /** Redacted stderr tail — the diagnostic a failed boot reports. */
  get stderrTail() {
    const lines = this.#err.split(/\r?\n/).filter((line) => line.length > 0)
    return redactToken(lines.slice(-STDERR_TAIL_LINES).join('\n'))
  }

  /**
   * Resolve once the URL line appears; reject on early exit or timeout.
   * @returns the full engine URL (including any `?token=`).
   */
  waitForUrl(timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const timer = setInterval(() => {
        if (this.#url !== null) {
          clearInterval(timer)
          resolve(this.#url)
        } else if (this.#exited !== null) {
          clearInterval(timer)
          reject(this.#failure(`engine exited before printing its URL (code=${String(this.#exited.code)} signal=${String(this.#exited.signal)})`))
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(this.#failure(`timed out after ${timeoutMs}ms waiting for the URL line`))
        }
      }, 100)
    })
  }

  /**
   * Wait `ms` and report whether the engine is still running.
   *
   * A URL line is not proof of a working engine: a version-incoherent tree
   * (e.g. `@deepseek-ai/dsh@0.1.5-rc.1` whose subpackages floated to
   * `0.1.5-rc.3`) binds the port, prints the URL, then dies in profile
   * settlement. Both the installer gate and the smoke test therefore require
   * the process to stay up after it has served a page.
   */
  async stayedUp(ms) {
    if (this.#exited !== null) return false
    await new Promise((resolve) => setTimeout(resolve, ms))
    return this.#exited === null
  }

  /** Exit summary (`{ code, signal }`) once the engine has exited, else null. */
  get exit() {
    return this.#exited
  }

  /** One-line, redacted stderr diagnostic for a failure message. */
  diagnostic() {
    const tail = this.stderrTail
    const hint = fingerprintHint(tail)
    return [tail, hint].filter((part) => part !== '').join('\n')
  }

  /**
   * SIGTERM, wait up to `timeoutMs`, then SIGKILL.
   * @returns the exit `{ code, signal }`, or null when nothing was running.
   */
  async stop(timeoutMs = 10_000) {
    const child = this.#child
    const waitExit = () => new Promise((resolve) => {
      if (this.#exited !== null) {
        resolve(this.#exited)
        return
      }
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', () => resolve(this.#exited ?? { code: null, signal: null }))
    })
    if (child.exitCode !== null || child.signalCode !== null || this.#exited !== null) return this.#exited
    child.kill('SIGTERM')
    const graceful = await Promise.race([waitExit(), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))])
    if (graceful !== null) return graceful
    child.kill('SIGKILL')
    return Promise.race([waitExit(), new Promise((resolve) => setTimeout(() => resolve(null), 2_000))])
  }

  #onOutput(chunk, stream) {
    if (stream === 'stdout') this.#out += chunk
    else this.#err += chunk
    const match = URL_LINE.exec(chunk)
    if (match !== null && this.#url === null) this.#url = match[1]
    // Keep complete lines only, so the tail a failure prints never ends on a
    // half-written line.
    const combined = this.#pending[stream] + chunk
    const lines = combined.split(/\r?\n/)
    this.#pending[stream] = lines.pop() ?? ''
  }

  #failure(reason) {
    const tail = this.stderrTail
    const hint = fingerprintHint(tail)
    const detail = [reason, ...(tail === '' ? [] : [`--- engine stderr (tail) ---`, tail]), ...(hint === '' ? [] : [hint])].join('\n')
    const error = new Error(detail)
    error.stderrTail = tail
    return error
  }
}

/**
 * Fetch the engine page exactly like the shell does and report what came back.
 *
 * Engine ≥ 0.1.5 gates `/` behind the per-boot `?token=` from the URL line:
 * `GET /?token=…` answers **303** with `Set-Cookie: dsh-auth-…`, and only a
 * *subsequent* request carrying that cookie gets 200. Node's `fetch` has no
 * cookie jar, so the redirect is followed by hand — otherwise a healthy engine
 * looks like a 401 failure (see `harness.ts` `probeHealthy`).
 *
 * @returns `{ ok: true, status }` when the page is a real engine boot page,
 * else `{ ok: false, reason }` with the reason to show in a failure message.
 */
export async function checkEnginePage(url) {
  let response
  try {
    const first = await fetch(url, { redirect: 'manual' })
    response = first
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location')
      if (location === null) return { ok: false, reason: `GET / returned HTTP ${first.status} without a Location header` }
      const cookie = first.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ')
      response = await fetch(new URL(location, url).toString(), cookie === '' ? undefined : { headers: { cookie } })
    }
  } catch (error) {
    return { ok: false, reason: `request failed: ${error?.cause?.code ?? (error instanceof Error ? error.message : String(error))}` }
  }
  if (!response.ok) return { ok: false, reason: `GET / returned HTTP ${response.status}` }
  const body = await response.text()
  if (!body.includes('__DSH_BOOT__')) return { ok: false, reason: 'page misses the __DSH_BOOT__ injection' }
  return { ok: true, status: response.status }
}

/**
 * Poll `checkEnginePage` until it succeeds or `timeoutMs` elapses.
 * @returns the last `checkEnginePage` result.
 */
export async function waitForHealthyPage(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let result = { ok: false, reason: 'not probed' }
  for (;;) {
    result = await checkEnginePage(url)
    if (result.ok) return result
    if (Date.now() > deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Actionable hint when the engine died on the known native-addon fingerprint
 * gate. Anything else (missing profile, port trouble, …) gets no hint — a
 * wrong guess is worse than no guess.
 */
function fingerprintHint(stderrTail) {
  if (!/node-addon-require-builtin|runtime fingerprint/i.test(stderrTail)) return ''
  return [
    'hint: this engine build requires the prebuilt node-addon-require-builtin',
    'addon, whose native binary only accepts specific Electron builds (an exact',
    'V8 fingerprint each). The shell must ship one of those Electron versions —',
    'keep the installed engine, or bump Electron to a supported build and',
    'reinstall. See docs/Electron基座应用开发.md §2.1.',
  ].join('\n')
}
