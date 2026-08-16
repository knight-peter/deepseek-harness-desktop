/**
 * Debug tooling (Phase 4): the composed-config tree view (`--dump-config`),
 * patch file read/write with YAML validation, and a line diff for
 * before/after comparisons. Electron-free: paths and node are injected.
 * @module dsh-desktop/tools
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'
import { join } from 'node:path'

export interface ToolsOptions {
  dshBin: string
  nodeCommand: string
  env: Record<string, string>
  profileDir: string
  dshHome: string
}

/** Tolerate `!!js` expressions (loader-interpolated) during validation. */
const jsTag = new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data: string) => `!!js ${data}` })

const PATCH_SCHEMA = DEFAULT_SCHEMA.extend([jsTag])

export interface PatchFile {
  name: 'profile' | 'home'
  path: string
  exists: boolean
  content: string
}

export class Tools {

  constructor(private readonly options: ToolsOptions) {}

  /** `dsh --profile web --dump-config`: the composed tree, no server booted. */
  dumpConfig(): { ok: boolean; output: string } {
    const result = spawnSync(this.options.nodeCommand, ['--expose-internals', this.options.dshBin, '--profile', 'web', '--dump-config'], {
      env: this.options.env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    return { ok: result.status === 0, output }
  }

  readPatchFiles(): PatchFile[] {
    const files: PatchFile[] = [
      { name: 'profile', path: join(this.options.profileDir, 'cordis.patch.yml'), exists: false, content: '' },
      { name: 'home', path: join(this.options.dshHome, 'cordis.patch.yml'), exists: false, content: '' },
    ]
    for (const file of files) {
      try {
        file.content = readFileSync(file.path, 'utf8')
        file.exists = true
      } catch {
        // keep the not-found defaults
      }
    }
    return files
  }

  /** Validate a patch file body (array of patch entries; `!!js` tolerated). */
  validatePatch(text: string): { ok: boolean; error?: string } {
    try {
      const parsed = load(text, { schema: PATCH_SCHEMA })
      if (parsed !== undefined && parsed !== null && !Array.isArray(parsed)) {
        return { ok: false, error: '补丁必须是顶层 YAML 数组' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Validate and write a patch file. Reports whether the change is
   * structural (entry ids added/removed → engine restart needed) or
   * config-only (patch HMR hot-applies it).
   */
  writePatch(name: 'profile' | 'home', text: string): { ok: boolean; needsRestart: boolean; error?: string } {
    const validation = this.validatePatch(text)
    if (!validation.ok) return { ok: false, needsRestart: false, error: validation.error }
    const files = this.readPatchFiles()
    const file = files.find((entry) => entry.name === name)
    if (file === undefined) return { ok: false, needsRestart: false, error: `unknown patch ${name}` }
    const before = idsOf(file.content)
    const after = idsOf(text)
    writeFileSync(file.path, text)
    const needsRestart = !setsEqual(before, after)
    return { ok: true, needsRestart }
  }

  /** Line diff between two texts (LCS-based, unified-ish +/- view). */
  diff(previous: string, current: string): string {
    const a = previous.split('\n')
    const b = current.split('\n')
    const lcs = longestCommonSubsequence(a, b)
    const lines: string[] = []
    let i = 0
    let j = 0
    for (const item of lcs) {
      while (i < a.length && a[i] !== item) lines.push(`- ${a[i++]}`)
      while (j < b.length && b[j] !== item) lines.push(`+ ${b[j++]}`)
      lines.push(`  ${item}`)
      i++
      j++
    }
    while (i < a.length) lines.push(`- ${a[i++]}`)
    while (j < b.length) lines.push(`+ ${b[j++]}`)
    return lines.join('\n')
  }
}

/** Entry ids a patch composes: targeted rows (`id`) and inserted rows (`insert[].id`). */
function idsOf(text: string): Set<string> {
  const ids = new Set<string>()
  try {
    const parsed = load(text, { schema: PATCH_SCHEMA }) as unknown
    if (!Array.isArray(parsed)) return ids
    for (const entry of parsed as Array<Record<string, unknown>>) {
      if (typeof entry?.id === 'string') ids.add(entry.id)
      const inserted = entry?.insert
      if (Array.isArray(inserted)) {
        for (const row of inserted as Array<Record<string, unknown>>) {
          if (typeof row?.id === 'string') ids.add(row.id)
        }
      }
    }
  } catch {
    // unparsable input yields an empty id set; writePatch validates first
  }
  return ids
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/** LCS of two line arrays (bounded: O(n*m) fine up to a few thousand lines). */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const result: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push(a[i])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return result
}
