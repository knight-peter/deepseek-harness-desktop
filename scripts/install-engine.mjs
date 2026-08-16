/**
 * Install the locked dsh engine into `resources/engine` (Phase 2).
 * Main path: npm registry with pinned versions (plain node_modules layout —
 * the web-app bundle resolves the frontend dist via require.resolve, so both
 * packages must share one tree). Fallback: build a DSH_CHECKOUT and install
 * `pnpm pack` tarballs of `apps/cli` and `apps/web` (pnpm pack rewrites
 * workspace: deps to concrete versions).
 * @module dsh-desktop/install-engine
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ENGINE_DIR = join(ROOT, 'resources', 'engine')
const ENGINE_MANIFEST = join(ENGINE_DIR, 'engine.json')

/** Pinned engine packages (registry state verified 2026-08-14). */
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

/** Registry install into a fresh resources/engine with pinned versions. */
function installFromRegistry() {
  mkdirSync(ENGINE_DIR, { recursive: true })
  writeFileSync(join(ENGINE_DIR, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-engine', private: true, dependencies: LOCKED }, null, 2)}\n`)
  return run('npm', ['install', '--no-audit', '--no-fund', '--prefix', ENGINE_DIR], ENGINE_DIR)
}

/** Build a DSH_CHECKOUT and install packed tarballs of apps/cli + apps/web. */
function installFromCheckout() {
  const checkout = process.env.DSH_CHECKOUT
  if (checkout === undefined || !existsSync(join(checkout, 'pnpm-workspace.yaml'))) {
    console.error('install-engine: fallback needs DSH_CHECKOUT pointing at a deepseek-harness checkout')
    return false
  }
  console.log(`install-engine: building checkout at ${checkout}`)
  if (!run('pnpm', ['install'], checkout)) return false
  if (!run('pnpm', ['run', 'build'], checkout)) return false
  const tarballs = []
  for (const dir of ['apps/cli', 'apps/web']) {
    const pack = spawnSync('pnpm', ['--dir', dir, 'pack', '--pack-destination', ENGINE_DIR], { cwd: checkout, encoding: 'utf8' })
    if (pack.status !== 0) {
      console.error(`install-engine: pnpm pack ${dir} failed (exit ${String(pack.status)})`)
      return false
    }
    const name = pack.stdout.trim().split('\n').at(-1)
    if (name === undefined || !existsSync(join(ENGINE_DIR, name))) {
      console.error(`install-engine: cannot locate pack output for ${dir}: ${pack.stdout}`)
      return false
    }
    tarballs.push(name)
  }
  const deps = {}
  for (const tarball of tarballs) deps[tarball] = `file:./${tarball}`
  writeFileSync(join(ENGINE_DIR, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-engine', private: true, dependencies: deps }, null, 2)}\n`)
  return run('npm', ['install', '--no-audit', '--no-fund', '--prefix', ENGINE_DIR], ENGINE_DIR)
}

/** Assert the installed tree is bootable: dsh bin + frontend dist present. */
function verify() {
  const bin = join(ENGINE_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dist = join(ENGINE_DIR, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(bin)) fail(`dsh bin missing: ${bin}`)
  if (!existsSync(dist)) fail(`frontend dist missing: ${dist}`)
  console.log(`install-engine: verified ${bin}`)
  console.log(`install-engine: verified ${dist}`)
}

function writeManifest(source) {
  writeFileSync(ENGINE_MANIFEST, `${JSON.stringify({ installedAt: new Date().toISOString(), source, packages: LOCKED }, null, 2)}\n`)
}

if (installFromRegistry() || installFromCheckout()) {
  verify()
  writeManifest('registry')
  console.log('install-engine: done')
} else {
  fail('both registry and checkout fallback failed')
}
