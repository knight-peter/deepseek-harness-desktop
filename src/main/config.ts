/**
 * dsh-desktop settings: a small JSON file in the userData directory.
 * Electron-free: the caller injects the directory. Loaded lazily and cached;
 * writes are atomic (tmp file + rename).
 * @module dsh-desktop/config
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Settings {
  /** Dev mode: path to a deepseek-harness checkout whose built CLI runs the engine. */
  checkoutPath?: string
  /** Advanced: start the engine with `NODE_OPTIONS=--inspect=<port>` for DevTools attach. */
  inspectPort?: number
  /** Whether to check for engine updates on launch. */
  autoCheckUpdates?: boolean
}

const DEFAULTS: Settings = {}

export class SettingsStore {
  private cache: Settings | null = null

  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'settings.json')
  }

  /** Read the current settings (cached after first load). */
  get(): Settings {
    if (this.cache === null) this.cache = this.read()
    return this.cache
  }

  /** Merge a patch into the settings and persist atomically. */
  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch }
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(tmp, this.file)
    this.cache = next
    return next
  }

  private read(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      return { ...DEFAULTS, ...parsed }
    } catch {
      return { ...DEFAULTS }
    }
  }
}
