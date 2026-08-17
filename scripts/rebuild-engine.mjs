/**
 * Rebuild engine native modules for the Electron ABI (Phase 2).
 * N-API prebuilds (path contains `prebuilt`) need no rebuild and are
 * skipped; any other `.node` binary is rebuilt with @electron/rebuild
 * against the Electron version in this workspace.
 * @module dsh-desktop/rebuild-engine
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_DIR = join(ROOT, 'resources', 'engine')

function findNativeModules(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      findNativeModules(path, out)
    } else if (name.endsWith('.node') && !path.includes(`${sep}prebuilt${sep}`)) {
      out.push(path)
    }
  }
  return out
}

const natives = findNativeModules(join(ENGINE_DIR, 'node_modules'))
if (natives.length === 0) {
  console.log('rebuild-engine: no non-prebuilt native modules found — nothing to rebuild (N-API prebuilds are ABI-stable)')
  process.exit(0)
}
console.log(`rebuild-engine: rebuilding ${natives.length} native module(s):`)
for (const file of natives) console.log(`  ${file}`)
// On Windows the .bin shim is a `.cmd` wrapper (no PATHEXT resolution in
// spawnSync); elsewhere it is a plain executable.
const bin = join(ROOT, 'node_modules', '.bin', `electron-rebuild${process.platform === 'win32' ? '.cmd' : ''}`)
const result = spawnSync(bin, ['-m', ENGINE_DIR], { stdio: 'inherit' })
if (result.status !== 0) {
  console.error(`rebuild-engine: electron-rebuild failed (exit ${String(result.status)})`)
  process.exit(result.status ?? 1)
}
console.log('rebuild-engine: done')
