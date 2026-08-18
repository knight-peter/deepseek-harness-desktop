/**
 * Engine subprocess hosting: spawn `dsh web` under Electron's embedded Node
 * (`ELECTRON_RUN_AS_NODE=1` + `process.execPath`), parse the printed URL
 * line, health-check the served page for the `__DSH_BOOT__` injection, and
 * tear down gracefully (SIGTERM → wait → SIGKILL). An abnormal exit is never
 * auto-restarted (AD-10); it becomes an `error` state for the UI.
 * @module dsh-desktop/harness
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Readable } from 'node:stream'

/** The engine process shape with `stdio: ['ignore', 'pipe', 'pipe']`. */
type EngineProcess = ChildProcessByStdio<null, Readable, Readable>

/** Whether a Node version string satisfies the engine range `^22.19.0 || >=24.0.0`. */
export function nodeSatisfiesEngine(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}

/** Harness state pushed to the UI. */
export type HarnessState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running'; url: string }
  | { kind: 'stopped'; code: number | null; signal: string | null }
  | { kind: 'error'; message: string; detail: string }

/** Callbacks the harness invokes for UI updates. */
export interface HarnessEvents {
  onStateChange(state: HarnessState): void
  onLog(line: string, stream: 'stdout' | 'stderr'): void
}

export interface StartOptions {
  /** Absolute path to the dsh CLI entry (`lib/bin.js`). */
  dshBin: string
  /** Extra Node CLI args for the engine process, before the script (e.g. `--require` preload). */
  nodeArgs?: string[]
  /** Working directory for the engine process (default: user home). */
  cwd?: string
  /** Extra environment variables, merged over the current environment. */
  env?: Record<string, string>
  /** How long to wait for the printed URL line before failing (ms). */
  urlTimeoutMs?: number
  /** How long to wait for the page health check before failing (ms). */
  healthTimeoutMs?: number
}

/** The line `dsh web` prints once the server binds (`dsh web: http://127.0.0.1:<port>`). */
const URL_LINE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/

export class Harness {
  private child: EngineProcess | null = null
  private state: HarnessState = { kind: 'idle' }
  private url: string | null = null
  private stopping = false
  private readonly recent: string[] = []
  private readonly pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private static readonly MAX_RECENT = 500

  constructor(private readonly events: HarnessEvents) {}

  get currentState(): HarnessState {
    return this.state
  }

  /** The most recent engine log lines (both streams, by arrival order). */
  get recentLogs(): string[] {
    return [...this.recent]
  }

  private recordLog(line: string, stream: 'stdout' | 'stderr'): void {
    this.recent.push(line)
    if (this.recent.length > Harness.MAX_RECENT) {
      this.recent.splice(0, this.recent.length - Harness.MAX_RECENT)
    }
    this.events.onLog(line, stream)
  }

  private setState(next: HarnessState): void {
    this.state = next
    this.events.onStateChange(next)
  }

  /**
   * Spawn the engine and wait until its page passes the health check.
   * @returns the served URL.
   */
  async start(options: StartOptions): Promise<string> {
    if (this.child !== null) throw new Error('harness: engine already running')
    if (!existsSync(options.dshBin)) {
      throw new Error(`harness: dsh bin not found: ${options.dshBin}`)
    }
    this.url = null
    this.stopping = false
    this.setState({ kind: 'starting' })

    // Under ELECTRON_RUN_AS_NODE the vendored loader's native internals hook
    // (node-addon-require-builtin) silently fails, so bare plugin specifiers
    // would not resolve; `--expose-internals` makes the loader use its plain
    // require fallback instead (verified on Electron 43 / embedded Node 24).
    const child = spawn(process.execPath, ['--expose-internals', ...(options.nodeArgs ?? []), options.dshBin, '--profile', 'web', '--port', '0'], {
      cwd: options.cwd ?? homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // electron.exe is a GUI-subsystem binary (no console window either
      // way), but keep the flag for consistency with every other spawn.
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onOutput(chunk, 'stdout'))
    child.stderr.on('data', (chunk: string) => this.onOutput(chunk, 'stderr'))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('error', (error) => {
      this.recordLog(`harness: spawn failed: ${String(error)}`, 'stderr')
      this.setState({ kind: 'error', message: '引擎进程启动失败', detail: String(error) })
    })

    let url: string
    try {
      url = await this.waitForUrl(options.urlTimeoutMs ?? 30_000)
      await this.waitHealthy(url, options.healthTimeoutMs ?? 30_000)
    } catch (error) {
      // A failed start must not leave the UI stuck on "starting".
      const detail = error instanceof Error ? error.message : String(error)
      this.recordLog(`harness: start failed — ${detail}`, 'stderr')
      this.setState({ kind: 'error', message: '引擎启动失败', detail })
      throw error
    }
    this.setState({ kind: 'running', url })
    return url
  }

  /**
   * Stop the engine: SIGTERM, wait up to `timeoutMs`, then SIGKILL.
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    const child = this.child
    if (child === null) return
    this.stopping = true
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit').then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    if (this.child === child) {
      this.child = null
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => undefined)
      }
      this.setState({ kind: 'stopped', code: child.exitCode, signal: child.signalCode })
    }
  }

  private waitForUrl(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const timer = setInterval(() => {
        if (this.url !== null) {
          clearInterval(timer)
          resolve(this.url)
        } else if (this.state.kind === 'error' || this.state.kind === 'stopped') {
          clearInterval(timer)
          reject(new Error(`harness: engine exited before printing its URL (${this.state.kind})`))
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error(`harness: timed out waiting for the URL line (${timeoutMs}ms)`))
        }
      }, 100)
    })
  }

  private async waitHealthy(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.child === null || this.state.kind === 'error' || this.state.kind === 'stopped') {
        throw new Error('harness: engine exited before the health check passed')
      }
      try {
        const response = await fetch(url)
        const body = await response.text()
        if (response.ok && body.includes('__DSH_BOOT__')) return
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        throw new Error(`harness: health check timed out (${timeoutMs}ms): ${url}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private onOutput(chunk: string, stream: 'stdout' | 'stderr'): void {
    const match = URL_LINE.exec(chunk)
    if (match !== null) this.url = match[1]
    // Complete lines are logged as they arrive; a trailing partial line
    // stays buffered until the next chunk (or is dropped at teardown).
    const combined = this.pending[stream] + chunk
    const lines = combined.split(/\r?\n/)
    this.pending[stream] = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length > 0) this.recordLog(line, stream)
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    if (this.stopping) {
      this.setState({ kind: 'stopped', code, signal: signal ?? null })
      return
    }
    const detail = `exit code=${String(code)} signal=${String(signal ?? 'none')}`
    this.recordLog(`harness: engine exited unexpectedly — ${detail}`, 'stderr')
    this.setState({ kind: 'error', message: '引擎异常退出（未自动重启，AD-10）', detail })
  }
}
