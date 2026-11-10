#!/usr/bin/env node
/**
 * Prepare the pinned, relocatable Office "primary runtime" payload
 * (CPython + Office wheels + office-skills) for packaging.
 *
 * Ported from upstream `deepseek-harness` `scripts/primary-runtime/prepare.ts`
 * (MIT, upstream commit 37983d9298, 2026-09-18). The lock lives in
 * `scripts/primary-runtime.lock.json` (verbatim copy of upstream
 * `scripts/primary-runtime/lock.json`) — every download is sha256-verified
 * against it, so a compromised or drifting mirror fails the build.
 *
 * Layout produced (read by `@deepseek-ai/dsh-tool-workspace-dependencies`
 * `workspaceDependencyPaths`, so do not restructure):
 *
 *   <output>/primary-runtime/
 *     runtime.json
 *     dependencies/
 *       python/                  # astral python-build-standalone, install_only_stripped
 *         bin/python3
 *         lib/python3.12/site-packages/   # 13 locked wheels, unpacked without pip
 *       node/  pnpm/             # only in --full mode (see below)
 *   <output>/office-skills/      # sibling — skill-office resolves assetRoot as
 *                                # <primary-runtime>/../office-skills
 *
 * Modes:
 *   default (python-only): no bundled Node.js/pnpm — the shell launches the
 *   engine under Electron-as-node itself, and `skill-office` is mounted with
 *   `cli: false` (the upstream "python-only carrier" mode). Saves ~110 MB of
 *   Node + pnpm per platform.
 *   --full: also bundle Node.js + pnpm (upstream parity; needed only if the
 *   agent must invoke the LibreOffice Kit CLI directly).
 *
 * Usage:
 *   node scripts/prepare-primary-runtime.mjs [--target mac-x64|mac-arm64|win-x64|linux-x64|linux-arm64]
 *                                            [--output resources/runtime]
 *                                            [--cache resources/downloads]
 *                                            [--lock scripts/primary-runtime.lock.json]
 *                                            [--full]
 *
 * Mirrors (opt-in via env; CI on GitHub uses the official sources by default):
 *   DSH_PRIMARY_RUNTIME_PYTHON_MIRROR  e.g. https://registry.npmmirror.com/-/binary/python-build-standalone/
 *   DSH_PRIMARY_RUNTIME_WHEEL_MIRROR   e.g. https://pypi.tuna.tsinghua.edu.cn/  (or .../pypi/ on aliyun)
 *   DSH_PRIMARY_RUNTIME_NODE_MIRROR    e.g. https://registry.npmmirror.com/-/binary/node/   (--full only)
 * A mirror only swaps the URL prefix — the bytes (and thus the sha256 the lock
 * verifies) are identical. Measured 2026-10-01 on a China connection: GitHub
 * direct ≈ 4 KB/s vs npmmirror/TUNA ≈ 7 MB/s.
 * @module dsh-desktop/prepare-primary-runtime
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { unzipSync } from 'fflate'
import { x as extractTar } from 'tar'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_OUTPUT = join(ROOT, 'resources', 'runtime')
const DEFAULT_CACHE = join(ROOT, 'resources', 'downloads')
const DEFAULT_LOCK = join(ROOT, 'scripts', 'primary-runtime.lock.json')

function fail(message) {
  console.error(`prepare-primary-runtime: ${message}`)
  process.exit(1)
}

/** Host platform/arch → lock target name. */
function hostTarget() {
  const key = `${process.platform}-${process.arch}`
  const map = {
    'darwin-x64': 'mac-x64',
    'darwin-arm64': 'mac-arm64',
    'win32-x64': 'win-x64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
  }
  return map[key] ?? null
}

/**
 * Swap a locked URL's prefix for a mirror's. The path suffix is identical on
 * the mirror, so the sha256 in the lock still validates the bytes.
 */
function mirrorOf(url, prefix, replacement) {
  return replacement !== undefined && replacement !== '' && url.startsWith(prefix)
    ? replacement + url.slice(prefix.length)
    : url
}

/**
 * Download or reuse an archive only when its bytes match the release lock.
 * Cache entries are named by their expected sha256, so a stale/corrupt file
 * can never pass silently: it either matches or is re-fetched and re-checked.
 */
async function downloadAsset(url, sha256, cache) {
  const destination = join(cache, sha256)
  let bytes
  try {
    bytes = readFileSync(destination)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    console.log(`prepare-primary-runtime: downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) fail(`download failed: HTTP ${response.status} ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== sha256) {
    rmSync(destination, { force: true })
    fail(`checksum mismatch for ${url}\n  expected ${sha256}\n  got      ${digest}\n  (deleted the cache entry — re-run to fetch again)`)
  }
  writeFileSync(destination, bytes)
  return destination
}

/** Astral python-build-standalone archive URL for a target. */
function pythonArchiveUrl(lock, target) {
  const artifact = lock.targets[target]
  const filename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(filename)}`
}

/**
 * SHA-256 payload identity (upstream `primaryRuntimePayloadDigest`, format 4):
 * covers everything that assembles one target's payload, so a rebuilt payload
 * can be cache-validated by manifest comparison alone.
 */
export function payloadDigest(target, lock, pnpmVersion) {
  const { pythonVersion, pythonRelease, nodeVersion, wheels, pythonPackages } = lock
  return createHash('sha256').update(JSON.stringify({
    format: 4, target, pythonVersion, pythonRelease,
    nodeVersion: pnpmVersion === undefined ? undefined : nodeVersion,
    artifact: lock.targets[target], wheels, pythonPackages, pnpm: pnpmVersion,
  })).digest('hex')
}

/**
 * Unpack a zip archive with fflate (pure JS — works on every Node version;
 * extract-zip 2.0.1's promise never settles on Node ≥ 25, observed as a
 * silent exit on Node 26.1.0).
 */
function extractZipArchive(archive, destination) {
  const entries = unzipSync(readFileSync(archive))
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
}

/**
 * Unpack a locked wheel into site-packages, rejecting wheels that require
 * installation schemes we do not implement (upstream rule: only `.data` root
 * and `.data/scripts` entries are tolerated; scripts keep their exec bit).
 */
async function unpackWheel(archive, destination) {
  const entries = unzipSync(readFileSync(archive))
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    const [directory, scheme] = name.split('/')
    if (directory?.endsWith('.data') && scheme !== '' && scheme !== 'scripts') {
      throw new Error(`prepare-primary-runtime: wheel requires unsupported installation paths: ${name}`)
    }
    const target = join(destination, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { mode: directory?.endsWith('.data') && scheme === 'scripts' ? 0o755 : 0o644 })
  }
}

/** Copy the skill package's complete asset tree to the payload's sibling dir. */
async function prepareOfficeSkillAssets(source, destination) {
  rmSync(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      cache: { type: 'string', default: DEFAULT_CACHE },
      lock: { type: 'string', default: DEFAULT_LOCK },
      full: { type: 'boolean', default: false },
    },
  })
  const target = values.target ?? hostTarget()
  if (target === null || target === undefined) fail(`cannot map host ${process.platform}-${process.arch} to a target — pass --target explicitly`)
  const lock = JSON.parse(readFileSync(values.lock, 'utf8'))
  if (!Object.hasOwn(lock.targets, target)) {
    fail(`unknown target "${target}" (lock has: ${Object.keys(lock.targets).join(', ')})`)
  }
  const pythonOnly = !values.full
  const output = resolve(values.output)
  const cache = resolve(values.cache)
  const artifact = lock.targets[target]
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const mirrors = {
    python: process.env.DSH_PRIMARY_RUNTIME_PYTHON_MIRROR,
    wheel: process.env.DSH_PRIMARY_RUNTIME_WHEEL_MIRROR,
    node: process.env.DSH_PRIMARY_RUNTIME_NODE_MIRROR,
  }

  mkdirSync(output, { recursive: true })
  mkdirSync(cache, { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'dsh-primary-runtime-'))
  try {
    const payload = join(staging, 'payload')
    const dependencies = join(payload, 'dependencies')
    mkdirSync(dependencies, { recursive: true })

    let pnpmVersion
    if (!pythonOnly) {
      // Bundled Node.js (only the interpreter binary + license) and pnpm,
      // mirroring upstream's full payload for carriers that need them.
      const nodeFilename = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
      const nodeArchive = await downloadAsset(mirrorOf(`https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFilename}`, 'https://nodejs.org/dist/', mirrors.node), artifact.nodeSha256, cache)
      const unpackedNode = join(staging, 'node')
      mkdirSync(unpackedNode)
      if (target === 'win-x64') extractZipArchive(nodeArchive, unpackedNode)
      else await extractTar({ file: nodeArchive, cwd: unpackedNode })
      const nodeSource = join(unpackedNode, nodeFilename.replace(/\.(?:zip|tar\.gz)$/u, ''))
      mkdirSync(join(dependencies, 'node', 'bin'), { recursive: true })
      mkdirSync(join(dependencies, 'node', 'node_modules'))
      writeFileSync(join(dependencies, 'node', 'node_modules', 'README.txt'), 'Reserved for bundled Node packages. pnpm uses its default installation directories.\n')
      cpSync(join(nodeSource, ...(target === 'win-x64' ? ['node.exe'] : ['bin', 'node'])),
        join(dependencies, 'node', 'bin', target === 'win-x64' ? 'node.exe' : 'node'))
      cpSync(join(nodeSource, 'LICENSE'), join(dependencies, 'node', 'LICENSE'))
      pnpmVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'pnpm', 'package.json'), 'utf8')).version
      await cp(join(ROOT, 'node_modules', 'pnpm'), join(dependencies, 'pnpm'), { recursive: true, dereference: true })
    }

    // CPython: the archive holds a top-level `python/` directory; extracting
    // into `dependencies/` lands it exactly at dependencies/python.
    const pythonArchive = await downloadAsset(
      mirrorOf(pythonArchiveUrl(lock, target), 'https://github.com/astral-sh/python-build-standalone/releases/download/', mirrors.python),
      artifact.pythonSha256, cache)
    await extractTar({ file: pythonArchive, cwd: dependencies })

    const manifest = {
      desktopVersion: version,
      platform: target === 'win-x64' ? 'win32' : target.startsWith('linux-') ? 'linux' : 'darwin',
      arch: target.endsWith('-arm64') ? 'arm64' : 'x64',
      payloadDigest: payloadDigest(target, lock, pnpmVersion),
      python: lock.pythonVersion,
      ...(pnpmVersion === undefined ? {} : { node: lock.nodeVersion, pnpm: pnpmVersion }),
      pythonPackages: lock.pythonPackages,
    }
    const sitePackages = join(dependencies, 'python',
      ...(manifest.platform === 'win32' ? ['Lib'] : ['lib', `python${lock.pythonVersion.split('.').slice(0, 2).join('.')}`]),
      'site-packages')
    for (const wheel of [...artifact.wheels, ...lock.wheels]) {
      await unpackWheel(await downloadAsset(mirrorOf(wheel.url, 'https://files.pythonhosted.org/', mirrors.wheel), wheel.sha256, cache), sitePackages)
    }
    writeFileSync(join(payload, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

    const destination = join(output, 'primary-runtime')
    rmSync(destination, { recursive: true, force: true })
    await cp(payload, destination, { recursive: true, dereference: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // office-skills must sit next to primary-runtime (skill-office resolves
  // assetRoot as <primary-runtime>/../office-skills).
  const engineAssets = join(ROOT, 'resources', 'engine', 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets')
  if (!existsSync(engineAssets)) fail(`engine skill assets not found: ${engineAssets} — run pnpm run install-engine first`)
  await prepareOfficeSkillAssets(engineAssets, join(output, 'office-skills'))

  console.log(`prepare-primary-runtime: ${target} payload ready at ${join(output, 'primary-runtime')} (${pythonOnly ? 'python-only' : 'full'})`)
}

const invoked = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (invoked) {
  main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}
