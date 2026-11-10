/**
 * Install the dsh engine into `resources/engine` (Phase 2).
 * Main path: npm registry. Fallback: build a DSH_CHECKOUT and install
 * `pnpm pack` tarballs of `apps/cli` and `apps/web` (pnpm pack rewrites
 * workspace: deps to concrete versions).
 *
 * Version selection: `DSH_ENGINE_VERSION` when set (the packaged app passes
 * the npm `latest` it shows behind 「应用引擎更新」, or the factory version for
 * its 「回滚」 button), else DEFAULT_ENGINE_VERSION. Only `dsh` is pinned —
 * the web frontend resolves transitively, see DEFAULT_ENGINE_VERSION.
 *
 * Atomic upgrade: when an engine already exists, the install happens in a
 * staging dir (`resources/engine.new`) and is swapped in only after
 * verification — a failed install leaves the old engine untouched
 * (Phase 5 acceptance: 模拟升级失败不破坏旧引擎).
 *
 * Package manager: pnpm first, npm as fallback (why: npm 11 stalls for
 * minutes on slow/proxy registries with zero output; pnpm fetches
 * concurrently, retries fast and reuses its store — see packageManager()).
 * The packaged shell shims `pnpm` + `node`; the symlinked pnpm layout is
 * fine for require.resolve as long as both engine packages share one tree.
 *
 * Engine dir: `resources/engine` under this script's repo root by default
 * (dev/CI). In a packaged app scripts/ runs from inside the read-only asar,
 * so the caller passes the real location via DSH_ENGINE_DIR
 * (src/main/index.ts `updater:apply` → `process.resourcesPath/engine`).
 * @module dsh-desktop/install-engine
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_DIR = process.env.DSH_ENGINE_DIR !== undefined
  ? resolve(process.env.DSH_ENGINE_DIR)
  : join(ROOT, 'resources', 'engine')
const STAGING_DIR = `${ENGINE_DIR}.new`
const ENGINE_MANIFEST = join(ENGINE_DIR, 'engine.json')

/**
 * Factory default engine version (registry state verified 2026-08-31).
 * Used when no version is passed (CI, first install, offline) — the packaged
 * app's `updater:apply` passes DSH_ENGINE_VERSION with the npm `latest` it
 * already shows in the UI, so an in-app engine update really moves forward.
 *
 * Only `dsh` is pinned: the web frontend resolves transitively through
 * dsh → dsh-web-app → dsh-web-frontend, so pinning it separately would put a
 * second, unused copy at the tree root *and* drag the engine onto a version
 * axis its own dependents do not share. See `verify()` for the resolution
 * anchor that this relies on.
 */
const DEFAULT_ENGINE_VERSION = '0.1.1-rc.2'

function fail(message) {
  console.error(`install-engine: ${message}`)
  process.exit(1)
}

/**
 * Engine version to install: `DSH_ENGINE_VERSION` when the caller supplies one
 * (the packaged app passes the npm `latest` behind its update button), else the
 * factory default. An explicit *empty* value is rejected rather than silently
 * falling back — a broken caller should not look like a successful pin.
 */
function resolveEngineVersion() {
  const override = process.env.DSH_ENGINE_VERSION
  if (override === undefined) return DEFAULT_ENGINE_VERSION
  const version = override.trim()
  if (version === '') fail('DSH_ENGINE_VERSION is set but empty — unset it to use the factory default')
  // Same shape the registry validates: reject obviously malformed values here
  // so a typo surfaces as a clear message instead of a resolver ETARGET.
  if (!/^[0-9][0-9A-Za-z.\-+]*$/.test(version)) fail(`DSH_ENGINE_VERSION "${version}" is not a valid version`)
  return version
}

/**
 * Resolve the package-manager command name for this platform. On Windows,
 * pnpm/npm are `.cmd` shims; Node's spawnSync does not apply PATHEXT, so a
 * bare `pnpm` ENOENTs. Everything else (darwin/linux) uses the plain name.
 */
function pmCommand(pm) {
  return process.platform === 'win32' ? `${pm}.cmd` : pm
}

/**
 * spawnSync wrapper: on Windows, executing a `.cmd`/`.bat` shim requires
 * `shell: true` (Node cannot run them directly); elsewhere plain spawn is
 * used. Merges extra options, so callers keep their stdio/encoding etc.
 * `windowsHide: true` keeps the console window hidden when this runs from a
 * console-less GUI parent (packaged app), matching background execution.
 */
function pmSpawn(command, args, options = {}) {
  return spawnSync(command, args, { ...options, shell: process.platform === 'win32', windowsHide: true })
}

function run(command, args, cwd, extraEnv = {}) {
  const result = pmSpawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
  if (result.status !== 0) {
    console.error(`install-engine: ${command} ${args.join(' ')} failed (exit ${String(result.status)})`)
    return false
  }
  return true
}

/**
 * Resolve the package manager, **pnpm first, npm as fallback**.
 *
 * Why pnpm first (2026-08-20 实测): on a proxy/Slow-registry network npm 11
 * stalls for minutes in the resolution phase with zero output — the engine
 * tree (547 deps) fetches packuments serially and a single hanging TCP
 * connection (e.g. fake-ip proxies, 198.18.0.0/15) blocks until npm's
 * default 5-minute fetch timeout, showing only the spinner. pnpm fetches
 * concurrently, retries fast, and reuses its content-addressable store
 * (the same engine installs in ~30s). It also matches the packaged app,
 * which shims pnpm for engine updates anyway.
 *
 * `npm_config_strict_dep_builds=false`（installInto 里以 env 传入）让 pnpm 11
 * （CI 默认 strict=true）不因忽略构建脚本而硬失败；pnpm 10 默认即 false。
 */
function packageManager() {
  if (pmSpawn(pmCommand('pnpm'), ['--version'], { stdio: 'ignore' }).status === 0) return 'pnpm'
  if (pmSpawn(pmCommand('npm'), ['--version'], { stdio: 'ignore' }).status === 0) return 'npm'
  return null
}

/** Write the pinned dependency manifest and install into `dir`. */
function installInto(dir, pm, dependencies) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-engine', private: true, dependencies }, null, 2)}\n`)
  const cmd = pmCommand(pm)
  if (pm === 'npm') {
    // npm fallback: shorter fetch timeouts so a hanging registry connection
    // fails fast and retries instead of stalling for minutes.
    return run(cmd, ['install', '--no-audit', '--no-fund', '--prefix', dir, '--fetch-timeout=60000', '--fetch-retries=5', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=30000'], dir)
  }
  // An empty pnpm-workspace.yaml makes `dir` its own workspace root: without
  // it pnpm walks UP from `dir` and finds the dsh-desktop repo's
  // pnpm-workspace.yaml, treats `dir` as a workspace member, and `pnpm
  // install --dir` then completes in <1s installing NOTHING (verified
  // 2026-08-20). With it, the engine installs standalone.
  // strict-dep-builds is a config-file key, not a CLI flag (pnpm rejects the
  // flag form); npm_config_* env is honored by pnpm 10/11 alike, so CI's
  // pnpm 11 (strict=true by default) won't hard-fail on ignored builds.
  // --node-linker=hoisted: pnpm's default symlinked layout puts packages
  // under a dot-dir `node_modules/.pnpm`, where the engine's resource loader
  // fails to intercept non-JS imports (boot dies with ERR_UNKNOWN_FILE_EXTENSION
  // on katex.min.css; verified 2026-08-20). The hoisted flat layout boots fine.
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), '')
  return run(cmd, ['install', '--dir', dir, '--node-linker=hoisted'], dir, { npm_config_strict_dep_builds: 'false' })
}

/** Registry install of one engine version. */
function installFromRegistry(dir, pm, version) {
  return installInto(dir, pm, { '@deepseek-ai/dsh': version })
}

/** Build a DSH_CHECKOUT and install packed tarballs of apps/cli + apps/web. */
function installFromCheckout(dir, pm) {
  const checkout = process.env.DSH_CHECKOUT
  if (checkout === undefined || !existsSync(join(checkout, 'pnpm-workspace.yaml'))) {
    console.error('install-engine: fallback needs DSH_CHECKOUT pointing at a deepseek-harness checkout')
    return false
  }
  console.log(`install-engine: building checkout at ${checkout}`)
  const pnpmCmd = pmCommand('pnpm')
  if (!run(pnpmCmd, ['install'], checkout)) return false
  if (!run(pnpmCmd, ['run', 'build'], checkout)) return false
  const tarballs = []
  for (const pkgDir of ['apps/cli', 'apps/web']) {
    const pack = pmSpawn(pnpmCmd, ['--dir', pkgDir, 'pack', '--pack-destination', dir], { cwd: checkout, encoding: 'utf8' })
    if (pack.status !== 0) {
      console.error(`install-engine: pnpm pack ${pkgDir} failed (exit ${String(pack.status)})`)
      return false
    }
    const name = pack.stdout.trim().split('\n').at(-1)
    if (name === undefined || !existsSync(join(dir, name))) {
      console.error(`install-engine: cannot locate pack output for ${pkgDir}: ${pack.stdout}`)
      return false
    }
    tarballs.push(name)
  }
  const dependencies = {}
  for (const tarball of tarballs) dependencies[tarball] = `file:./${tarball}`
  return installInto(dir, pm, dependencies)
}

/**
 * Locate the frontend dist the engine will actually serve.
 *
 * Anchor matters: upstream `dsh-web-app` calls `require.resolve(...)` from its
 * own directory, so the copy resolved *there* is the one served. Checking the
 * engine root instead used to pass while the served copy was a different,
 * nested one — validation that meant nothing. Exported for testing.
 */
export function resolveFrontendDist(dir) {
  const webApp = join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-app')
  // web-app is the real anchor; the engine root is a fallback for trees where
  // web-app itself lives nested (non-hoisted layouts).
  const anchor = existsSync(join(webApp, 'package.json')) ? webApp : dir
  try {
    return createRequire(join(anchor, 'package.json')).resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    return null
  }
}

/** Assert the installed tree is bootable: dsh bin + the *served* frontend dist. */
function verify(dir) {
  const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) fail(`dsh bin missing: ${bin}`)
  const dist = resolveFrontendDist(dir)
  if (dist === null) fail(`cannot resolve @deepseek-ai/dsh-web-frontend/dist/index.html from ${dir}`)
  if (!existsSync(dist)) fail(`frontend dist missing: ${dist}`)
  console.log(`install-engine: verified ${bin}`)
  console.log(`install-engine: verified ${dist}`)
}

/**
 * Drop foreign-platform prebuilds (node-gyp-build layout:
 * `prebuilds/<platform>-<arch>/`). node-pty alone ships ~58MB of win32
 * binaries that this tree will never load. Conservative: a `prebuilds` root
 * is pruned only when it contains the current platform's directory; files at
 * the root are never touched. Exported for direct testing.
 */
export function pruneForeignPrebuilds(dir) {
  const roots = []
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const path = join(current, name)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (name === 'prebuilds') roots.push(path)
      else walk(path)
    }
  }
  walk(dir)

  const platformPrefix = `${process.platform}-${process.arch}`
  const muslPrefix = `${process.platform}musl-${process.arch}`
  let removed = 0
  let prunedRoots = 0
  for (const root of roots) {
    const entries = readdirSync(root)
    if (!entries.some((entry) => entry.startsWith(platformPrefix) || entry.startsWith(muslPrefix))) continue
    for (const entry of entries) {
      if (entry.startsWith(platformPrefix) || entry.startsWith(muslPrefix)) continue
      const path = join(root, entry)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      rmSync(path, { recursive: true, force: true })
      removed++
    }
    prunedRoots++
  }
  if (removed > 0) {
    console.log(`install-engine: pruned ${removed} foreign prebuild dir(s) across ${prunedRoots} package(s)`)
  }
}

/**
 * Write `engine.json`. The version is read back from the installed tree rather
 * than taken from the request: the checkout fallback installs whatever the
 * checkout holds, so recording the requested version would make this file lie —
 * and this file is the first thing to check when an update "did not take".
 */
function writeManifest(source, dir = ENGINE_DIR) {
  const packages = {}
  const version = readInstalledVersion(dir)
  if (version !== null) packages['@deepseek-ai/dsh'] = version
  writeFileSync(join(dir, 'engine.json'), `${JSON.stringify({ installedAt: new Date().toISOString(), source, packages }, null, 2)}\n`)
}

/** Version of the dsh package inside an installed tree, or null. */
function readInstalledVersion(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

function main() {
  const version = resolveEngineVersion()
  const pm = packageManager()
  if (pm === null) fail(`neither npm nor pnpm is available on PATH (PATH=${process.env.PATH ?? ''}) — a packaged app needs its runtime-bin shims, see updater:apply`)
  console.log(`install-engine: package manager = ${pm}`)
  console.log(`install-engine: engine version = ${version} (${process.env.DSH_ENGINE_VERSION === undefined ? 'factory default' : 'DSH_ENGINE_VERSION'})`)

  const existing = existsSync(ENGINE_DIR) && readdirSync(ENGINE_DIR).some((name) => name === 'node_modules')
  const target = existing ? STAGING_DIR : ENGINE_DIR
  rmSync(target, { recursive: true, force: true })

  let source = ''
  if (installFromRegistry(target, pm, version)) {
    source = 'registry'
  } else if (installFromCheckout(target, pm)) {
    source = 'checkout'
  } else {
    rmSync(target, { recursive: true, force: true })
    fail('both registry and checkout fallback failed — the existing engine (if any) is untouched')
  }

  pruneForeignPrebuilds(target)
  verify(target)

  if (target === STAGING_DIR) {
    // Atomic swap: old engine is preserved until the new tree verifies.
    const backup = `${ENGINE_DIR}.old`
    rmSync(backup, { recursive: true, force: true })
    renameSync(ENGINE_DIR, backup)
    try {
      renameSync(STAGING_DIR, ENGINE_DIR)
    } catch (error) {
      renameSync(backup, ENGINE_DIR)
      fail(`swap failed, restored the previous engine: ${String(error)}`)
    }
    rmSync(backup, { recursive: true, force: true })
  }

  writeManifest(source)
  console.log('install-engine: done')
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
