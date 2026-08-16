/**
 * Install the locked dsh engine into `resources/engine` (Phase 2).
 * Main path: npm registry with pinned versions. Fallback: build a
 * DSH_CHECKOUT and install `pnpm pack` tarballs of `apps/cli` and `apps/web`
 * (pnpm pack rewrites workspace: deps to concrete versions).
 *
 * Atomic upgrade: when an engine already exists, the install happens in a
 * staging dir (`resources/engine.new`) and is swapped in only after
 * verification — a failed install leaves the old engine untouched
 * (Phase 5 acceptance: 模拟升级失败不破坏旧引擎).
 *
 * Package manager: npm when available (plain layout), else pnpm from PATH
 * (the packaged shell shims `pnpm` + `node`; symlinked layout is fine for
 * require.resolve as long as both engine packages share one tree).
 * @module dsh-desktop/install-engine
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_DIR = join(ROOT, 'resources', 'engine')
const STAGING_DIR = `${ENGINE_DIR}.new`
const ENGINE_MANIFEST = join(ENGINE_DIR, 'engine.json')

/** Pinned engine packages (registry state verified 2026-08-16). */
const LOCKED = {
  '@deepseek-ai/dsh': '0.1.0-rc.6',
  '@deepseek-ai/dsh-web-frontend': '0.0.1-rc.5',
}

function fail(message) {
  console.error(`install-engine: ${message}`)
  process.exit(1)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`install-engine: ${command} ${args.join(' ')} failed (exit ${String(result.status)})`)
    return false
  }
  return true
}

function packageManager() {
  if (spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0) return 'npm'
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0) return 'pnpm'
  return null
}

/** Write the pinned dependency manifest and install into `dir`. */
function installInto(dir, pm, dependencies) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-engine', private: true, dependencies }, null, 2)}\n`)
  if (pm === 'npm') return run('npm', ['install', '--no-audit', '--no-fund', '--prefix', dir], dir)
  return run('pnpm', ['install', '--dir', dir], dir)
}

/** Registry install with pinned versions. */
function installFromRegistry(dir, pm) {
  return installInto(dir, pm, LOCKED)
}

/** Build a DSH_CHECKOUT and install packed tarballs of apps/cli + apps/web. */
function installFromCheckout(dir, pm) {
  const checkout = process.env.DSH_CHECKOUT
  if (checkout === undefined || !existsSync(join(checkout, 'pnpm-workspace.yaml'))) {
    console.error('install-engine: fallback needs DSH_CHECKOUT pointing at a deepseek-harness checkout')
    return false
  }
  console.log(`install-engine: building checkout at ${checkout}`)
  if (!run('pnpm', ['install'], checkout)) return false
  if (!run('pnpm', ['run', 'build'], checkout)) return false
  const tarballs = []
  for (const pkgDir of ['apps/cli', 'apps/web']) {
    const pack = spawnSync('pnpm', ['--dir', pkgDir, 'pack', '--pack-destination', dir], { cwd: checkout, encoding: 'utf8' })
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

/** Assert the installed tree is bootable: dsh bin + frontend dist present. */
function verify(dir) {
  const bin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dist = join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(bin)) fail(`dsh bin missing: ${bin}`)
  if (!existsSync(dist)) fail(`frontend dist missing: ${dist}`)
  console.log(`install-engine: verified ${bin}`)
  console.log(`install-engine: verified ${dist}`)
}

function writeManifest(source, dir = ENGINE_DIR) {
  writeFileSync(join(dir, 'engine.json'), `${JSON.stringify({ installedAt: new Date().toISOString(), source, packages: LOCKED }, null, 2)}\n`)
}

function main() {
  const pm = packageManager()
  if (pm === null) fail('neither npm nor pnpm is available on PATH')
  console.log(`install-engine: package manager = ${pm}`)

  const existing = existsSync(ENGINE_DIR) && readdirSync(ENGINE_DIR).some((name) => name === 'node_modules')
  const target = existing ? STAGING_DIR : ENGINE_DIR
  rmSync(target, { recursive: true, force: true })

  let source = ''
  if (installFromRegistry(target, pm)) {
    source = 'registry'
  } else if (installFromCheckout(target, pm)) {
    source = 'checkout'
  } else {
    rmSync(target, { recursive: true, force: true })
    fail('both registry and checkout fallback failed — the existing engine (if any) is untouched')
  }

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

main()
