#!/usr/bin/env node
/**
 * Office capability smoke test: prove the *shipped wiring* works end to end —
 * the office overlay (`resources/office.patch.yml`) plus the primary-runtime
 * payload (`resources/runtime/primary-runtime`), exactly as the packaged app
 * passes them (`--patch` + `DSH_BUNDLED_PRIMARY_RUNTIME`).
 *
 * Assertions (see docs/plans/2026-10-01-…实施方案 §一):
 *   1. `--dump-config` composes the two overlay entries (workspace-dependencies,
 *      skill-office) — the overlay is really applied, not silently ignored.
 *   2. The engine boots under Electron-as-node with the overlay + payload and
 *      serves a healthy page (skill-office's eager asset validation runs here).
 *   3. The payload's own Python authors a DOCX, `check_office.py` passes on it,
 *      and the bundled LibreOffice converts it to PDF — the full agent chain.
 *
 * Skips (exit 0 with a note) when the payload is not prepared, so dev
 * checkouts without `pnpm run prepare-primary-runtime` are unaffected.
 *
 * Usage: node scripts/smoke-office.mjs
 * @module dsh-desktop/smoke-office
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTempDshHome, EngineBoot, engineRuntimeBin, originOfUrl, waitForHealthyPage } from './engine-boot-check.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PAYLOAD = join(ROOT, 'resources', 'runtime', 'primary-runtime')
const OVERLAY = join(ROOT, 'resources', 'office.patch.yml')
const ENGINE_BIN = join(ROOT, 'resources', 'engine', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const LIBREOFFICE_CLI = join(ROOT, 'resources', 'engine', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js')

const BOOT_TIMEOUT_MS = 120_000
const HEALTH_TIMEOUT_MS = 30_000
const SETTLE_MS = 3_000

function fail(message) {
  console.error(`smoke-office: FAIL — ${message}`)
  process.exit(1)
}

/** The two plugin ids the overlay must compose into the web profile. */
const OVERLAY_IDS = ['workspace-dependencies', 'skill-office']

async function main() {
  if (!existsSync(join(PAYLOAD, 'runtime.json')) || !existsSync(OVERLAY)) {
    console.log('smoke-office: SKIP — no prepared payload/overlay (run pnpm run prepare-primary-runtime first)')
    return
  }
  const runtimeBin = engineRuntimeBin()
  const env = { ...process.env, DSH_BUNDLED_PRIMARY_RUNTIME: PAYLOAD }
  const patchArgs = ['--patch', OVERLAY]

  // 1. The overlay composes: dump-config with the same env/args the shell uses.
  {
    const { spawnSync } = await import('node:child_process')
    const dump = spawnSync(runtimeBin, ['--expose-internals', ENGINE_BIN, '--profile', 'web', ...patchArgs, '--dump-config'], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-office-dump-')) },
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    })
    const output = `${dump.stdout ?? ''}${dump.stderr ?? ''}`
    if (dump.status !== 0) fail(`--dump-config exited ${String(dump.status)}:\n${output.slice(-1500)}`)
    for (const id of OVERLAY_IDS) {
      if (!output.includes(`id: ${id}`)) fail(`--dump-config misses the overlay entry "${id}"`)
    }
    console.log(`smoke-office: overlay composes (${OVERLAY_IDS.join(', ')})`)
  }

  // 2. Engine boots with the overlay + payload and stays up after serving.
  const scratch = createTempDshHome()
  const boot = new EngineBoot({
    dshBin: ENGINE_BIN,
    home: scratch.path,
    env: { DSH_BUNDLED_PRIMARY_RUNTIME: PAYLOAD },
    args: patchArgs,
  })
  try {
    const url = await boot.waitForUrl(BOOT_TIMEOUT_MS)
    console.log(`smoke-office: engine URL = ${originOfUrl(url)}`)
    const page = await waitForHealthyPage(url, HEALTH_TIMEOUT_MS)
    if (!page.ok) fail(`engine never served a healthy page (${page.reason})\n${boot.diagnostic()}`)
    if (!(await boot.stayedUp(SETTLE_MS))) {
      const exit = boot.exit
      fail(`engine served a page but exited right after (code=${String(exit?.code)} signal=${String(exit?.signal)})\n${boot.diagnostic()}`)
    }
    console.log('smoke-office: boot + healthy page OK')
  } finally {
    await boot.stop()
    scratch.cleanup()
  }

  // 3. The agent chain with the payload's own interpreter: author → check → convert.
  const manifest = JSON.parse(readFileSync(join(PAYLOAD, 'runtime.json'), 'utf8'))
  const python = join(PAYLOAD, 'dependencies', 'python', ...(manifest.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']))
  const work = mkdtempSync(join(tmpdir(), 'dsh-office-chain-'))
  try {
    const docx = join(work, 'chain.docx')
    const pdf = join(work, 'chain.pdf')
    const checks = join(work, 'checks.json')
    execFileSync(python, ['-I', '-B', '-c',
      'from docx import Document; d = Document(); d.add_paragraph("smoke-office chain 2026-10-01"); d.save(' + JSON.stringify(docx) + ')'],
      { stdio: 'inherit', timeout: 60_000 })
    execFileSync(python, ['-I', '-B', join(ROOT, 'resources', 'runtime', 'office-skills', 'scripts', 'check_office.py'),
      docx, '--contains', 'smoke-office chain', '--out', checks], { stdio: 'inherit', timeout: 60_000 })
    execFileSync(runtimeBin, [LIBREOFFICE_CLI, 'convert', '--input', docx, '--output', pdf], {
      stdio: 'inherit',
      // Linux resolves the wasm LibreOffice engine (no native build); its
      // first-run JIT makes a tiny conversion far slower than native's ~15 s.
      timeout: 240_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const header = readFileSync(pdf).subarray(0, 5).toString('latin1')
    if (header !== '%PDF-') fail(`converter output is not a PDF: ${pdf}`)
    console.log('smoke-office: python-docx → check_office.py → LibreOffice PDF OK')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  console.log('smoke-office: PASS')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
