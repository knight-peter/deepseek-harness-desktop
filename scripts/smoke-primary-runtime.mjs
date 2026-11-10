#!/usr/bin/env node
/**
 * Smoke-check a prepared Office primary-runtime payload: interpreter runs,
 * declared wheels import at the locked versions, and check_office.py works —
 * all with the payload's own isolated interpreter (no host Python involved).
 *
 * Ported from upstream `deepseek-harness` `smokePrimaryRuntime`
 * (MIT, upstream commit 37983d9298). Uses the verbatim copy
 * `scripts/primary-runtime-smoke.py` for the library-level checks.
 *
 * A payload whose manifest targets another platform/arch is skipped (a
 * cross-built artifact can't be executed on this host) — that is a pass with
 * a note, not a failure, so multi-arch CI stages can run unconditionally.
 *
 * Usage: node scripts/smoke-primary-runtime.mjs [payload-dir]
 *   (default: resources/runtime/primary-runtime)
 * @module dsh-desktop/smoke-primary-runtime
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PAYLOAD = process.argv[2] !== undefined ? resolve(process.argv[2]) : join(ROOT, 'resources', 'runtime', 'primary-runtime')
const SMOKE_PY = join(ROOT, 'scripts', 'primary-runtime-smoke.py')

function fail(message) {
  console.error(`smoke-primary-runtime: FAIL — ${message}`)
  process.exit(1)
}

function main() {
  const manifestFile = join(PAYLOAD, 'runtime.json')
  if (!existsSync(manifestFile)) fail(`runtime.json not found: ${manifestFile} — run pnpm run prepare-primary-runtime first`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))

  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    console.log(`smoke-primary-runtime: SKIP — payload targets ${manifest.platform}-${manifest.arch}, host is ${process.platform}-${process.arch}`)
    return
  }
  if (Object.keys(manifest.pythonPackages ?? {}).length === 0) {
    fail('manifest declares no Python distributions')
  }

  const win = manifest.platform === 'win32'
  const python = join(PAYLOAD, 'dependencies', 'python', ...(win ? ['python.exe'] : ['bin', 'python3']))
  if (!existsSync(python)) fail(`interpreter missing: ${python}`)
  const node = manifest.node === undefined
    ? undefined
    : join(PAYLOAD, 'dependencies', 'node', 'bin', win ? 'node.exe' : 'node')
  const pnpm = manifest.pnpm === undefined
    ? undefined
    : join(PAYLOAD, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')

  // Match upstream: scrub credential-shaped names from the subprocess env.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
  const options = { stdio: 'inherit', timeout: 120_000, env }

  // 1. Interpreter baseline + the two heavy libraries actually work.
  execFileSync(python, ['-I', '-B', '-c',
    'import decimal, xml.parsers.expat, lzma, uuid, numpy, pandas; assert numpy.arange(4).sum() == 6; assert pandas.DataFrame({"n": [1, 2]}).n.sum() == 3'], options)
  console.log('smoke-primary-runtime: interpreter + numpy/pandas OK')

  // 2. Full library matrix: every declared distribution at its locked version,
  //    every Office library writes and re-reads a document, check_office.py passes.
  const checkOffice = join(dirname(PAYLOAD), 'office-skills', 'scripts', 'check_office.py')
  execFileSync(python, ['-I', '-B', SMOKE_PY, JSON.stringify(manifest.pythonPackages), manifest.python, checkOffice], options)
  console.log('smoke-primary-runtime: office libraries + check_office.py OK')

  // 3. Dependency closure is self-consistent (pip ships with the standalone build).
  execFileSync(python, ['-I', '-B', '-m', 'pip', 'check'], options)
  console.log('smoke-primary-runtime: pip check OK')

  if (node !== undefined) {
    execFileSync(node, ['-e', `if (process.versions.node !== ${JSON.stringify(manifest.node)}) process.exit(1)`], options)
    console.log('smoke-primary-runtime: bundled Node version OK')
  }
  if (node !== undefined && pnpm !== undefined) {
    execFileSync(node, [pnpm, '--version'], options)
    console.log('smoke-primary-runtime: bundled pnpm OK')
  }

  console.log('smoke-primary-runtime: PASS')
}

main()
