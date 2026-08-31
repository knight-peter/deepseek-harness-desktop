/**
 * File-backed diagnostics for the updater and the quit flow.
 *
 * In a packaged GUI app the main process console is invisible (stdout goes
 * nowhere), so electron-updater's default `console` logger made every update
 * failure silent — the exact failure mode behind "下载了但装不上" reports.
 * This module appends the updater's own logs AND the app-level quit/update
 * flow diagnostics to `<userData>/updater.log`, mirroring them to the console
 * so `electron .` dev runs still show them live.
 * @module dsh-desktop/updaterLog
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** The electron-updater logger interface (`autoUpdater.logger`). */
export interface UpdaterLogger {
  info(message?: unknown, ...args: unknown[]): void
  warn(message?: unknown, ...args: unknown[]): void
  error(message?: unknown, ...args: unknown[]): void
  debug(message?: unknown, ...args: unknown[]): void
}

function text(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: 'info' | 'warn' | 'error' | 'debug', message?: unknown, args?: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${[message, ...(args ?? [])].map(text).join(' ')}`
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log
  consoleMethod(`[updater-log] ${line}`)
  try {
    appendFileSync(join(app.getPath('userData'), 'updater.log'), `${line}\n`)
  } catch (error) {
    // The log file is best-effort only; never let logging break the app.
    console.error('[updater-log] write failed:', error)
  }
}

/** Logger handed to `autoUpdater.logger` (electron-updater internal logs). */
export const updaterLogger: UpdaterLogger = {
  info: (message, ...args) => write('info', message, args),
  warn: (message, ...args) => write('warn', message, args),
  error: (message, ...args) => write('error', message, args),
  debug: (message, ...args) => write('debug', message, args),
}

/** App-level diagnostics (quit flow, update decisions) — same log file. */
export function appLog(level: 'info' | 'warn' | 'error', message: string): void {
  write(level, message)
}
