/**
 * Engine update support (Phase 5): registry version check, installed-version
 * read, and `$DSH_HOME` backup. The actual engine swap reuses
 * `scripts/install-engine.mjs` (spawned by the caller). Electron-free.
 * @module dsh-desktop/updater
 */

import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface UpdaterOptions {
  engineDir: string
  dshHome: string
}

/** Latest published version of an engine package, or null when unreachable. */
export async function latestEngineVersion(packageName = '@deepseek-ai/dsh'): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
    if (!response.ok) return null
    const doc = (await response.json()) as { version?: string }
    return doc.version ?? null
  } catch {
    return null
  }
}

/** Installed engine version from `resources/engine`, or null. */
export function installedEngineVersion(options: UpdaterOptions): string | null {
  const manifest = readJson(join(options.engineDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return manifest?.version !== undefined ? String(manifest.version) : null
}

/**
 * Backup `$DSH_HOME` to a timestamped sibling directory
 * (`$DSH_HOME-backup-<ts>`). Returns the backup path, or null when the home
 * does not exist.
 */
export function backupDshHome(options: UpdaterOptions): string | null {
  if (!existsSync(options.dshHome)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${options.dshHome}-backup-${stamp}`
  cpSync(options.dshHome, target, { recursive: true })
  return target
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}
