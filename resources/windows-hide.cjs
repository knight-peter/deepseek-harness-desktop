/**
 * Desktop-owned Windows hosting constraint (mechanism B in
 * docs/plans/Windows弹窗修复方案.md): when the engine runs under a
 * console-less GUI parent (packaged dsh-desktop on Windows), every console
 * child it spawns (cmd.exe via `shell: true`, node.exe, npm/pnpm .cmd shims)
 * would otherwise get a brand-new VISIBLE console window. This preload is
 * injected into the engine process via `--require` and forces
 * `windowsHide: true` (CreateProcess CREATE_NO_WINDOW) on child_process'
 * spawn APIs, so commands run in a hidden console — the same "background
 * execution" behavior `dsh web` has when run from a terminal.
 *
 * Only `spawn`/`spawnSync` are patched: exec/execFile/execSync/execFileSync
 * all delegate to them internally in Node's child_process implementation.
 *
 * Windows-only; a no-op elsewhere. Loaded by the desktop shell only — the
 * engine's code and artifacts are never modified.
 */
'use strict'

if (process.platform !== 'win32') return
if (globalThis.__dshWindowsHidePatched === true) return
globalThis.__dshWindowsHidePatched = true

const cp = require('node:child_process')

/** Return an options object with windowsHide forced on (never mutates input). */
function hide(options) {
  if (options === undefined || options === null) return { windowsHide: true }
  if (options.windowsHide === true) return options
  return { ...options, windowsHide: true }
}

const originalSpawn = cp.spawn
cp.spawn = function (command, args, options) {
  if (Array.isArray(args)) {
    return originalSpawn.call(this, command, args, hide(options))
  }
  // spawn(command, options): options sits in the args slot.
  if (args !== undefined && args !== null && typeof args === 'object') {
    return originalSpawn.call(this, command, hide(args))
  }
  // spawn(command) / spawn(command, undefined, options): keep the original
  // argument positions so options in the third slot are never dropped.
  return originalSpawn.call(this, command, args, hide(options))
}

const originalSpawnSync = cp.spawnSync
cp.spawnSync = function (command, args, options) {
  if (Array.isArray(args)) {
    return originalSpawnSync.call(this, command, args, hide(options))
  }
  if (args !== undefined && args !== null && typeof args === 'object') {
    return originalSpawnSync.call(this, command, hide(args))
  }
  return originalSpawnSync.call(this, command, args, hide(options))
}
