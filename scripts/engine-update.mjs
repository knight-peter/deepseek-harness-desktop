/**
 * One-command engine update (Phase 2 convenience wrapper).
 *
 * Bumps the pinned engine versions in install-engine.mjs's `LOCKED` block to
 * the latest published versions, then runs the standard verification chain
 * (install-engine → rebuild-engine → smoke) against the new pin.
 *
 *   pnpm run engine-update              # default: query npm latest → rewrite
 *                                       # LOCKED (left uncommitted) → install →
 *                                       # rebuild → smoke
 *   pnpm run engine-update --no-bump    # skip the LOCKED rewrite — reinstall /
 *                                       # repair with the currently pinned versions
 *   pnpm run engine-update --version 0.1.1-rc.2  # pin @deepseek-ai/dsh to an
 *                                       # explicit version (dsh-web-frontend
 *                                       # still follows npm latest)
 *   pnpm run engine-update --dry-run    # print old → new without touching anything
 *   pnpm run engine-update --no-smoke   # skip the boot smoke test
 *
 * Design notes:
 *   - LOCAL developer convenience only. CI (build.yml) and the packaged app
 *     (updater:apply) keep calling install-engine.mjs / rebuild-engine.mjs
 *     directly — CI must build the committed LOCKED, and the app must never
 *     mutate its (read-only asar) LOCKED.
 *   - The LOCKED rewrite is intentionally NOT committed: it is a source-level
 *     dependency pin and gets the same review/commit discipline as any other
 *     code change. Review with `git diff scripts/install-engine.mjs`.
 *   - Steps reuse the existing scripts unchanged (thin orchestration, no
 *     duplicated logic); the first failing step aborts with its exit code.
 *   - LOCKED pins both engine packages to one install tree (the web frontend
 *     must resolve from the same node_modules), so both are always bumped
 *     together.
 * @module dsh-desktop/engine-update
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const INSTALL_SCRIPT = join(ROOT, 'scripts', 'install-engine.mjs')
const REBUILD_SCRIPT = join(ROOT, 'scripts', 'rebuild-engine.mjs')
const SMOKE_SCRIPT = join(ROOT, 'scripts', 'smoke.mjs')

/** Engine packages pinned together in install-engine.mjs's LOCKED block. */
const PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-frontend']

function fail(message) {
  console.error(`engine-update: ${message}`)
  process.exit(1)
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseArgs(argv) {
  const args = { bump: true, dryRun: false, smoke: true, explicit: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-bump') args.bump = false
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-smoke') args.smoke = false
    else if (arg === '--version') {
      const value = argv[++i]
      if (value === undefined) fail('--version requires a version argument (e.g. --version 0.1.1-rc.2)')
      args.explicit = value
    } else fail(`unknown argument "${arg}" (see the header comment for usage)`)
  }
  if (args.explicit !== null && !/^[0-9][0-9A-Za-z.\-+]*$/.test(args.explicit)) {
    fail(`invalid --version "${args.explicit}" (expected a version like 0.1.1-rc.2)`)
  }
  if (!args.bump && args.explicit !== null) {
    console.log('engine-update: --version ignored (--no-bump keeps the pinned versions)')
    args.explicit = null
  }
  return args
}

/** Latest `dist-tag latest` version of a package; null when unreachable. */
async function latestVersion(pkg) {
  // `npm view` first so npmrc registry/proxy config applies; plain fetch as
  // a fallback for environments where npm is not on PATH.
  const viaNpm = spawnSync('npm', ['view', pkg, 'version'], { encoding: 'utf8' })
  const text = (viaNpm.stdout ?? '').trim()
  if (viaNpm.status === 0 && /^\S+$/.test(text)) return text
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`)
    if (!response.ok) return null
    const doc = await response.json()
    return typeof doc?.version === 'string' ? doc.version : null
  } catch {
    return null
  }
}

/** Current pinned versions read from install-engine.mjs. */
function parseLocked(source) {
  const versions = new Map()
  for (const pkg of PACKAGES) {
    const match = new RegExp(`'${escapeRegExp(pkg)}':\\s*'([^']+)'`).exec(source)
    if (match === null) fail(`cannot locate the LOCKED entry for ${pkg} in scripts/install-engine.mjs`)
    versions.set(pkg, match[1])
  }
  return versions
}

/**
 * Rewrite the LOCKED block versions and the "registry state verified <date>"
 * comment in place. Returns the new file content (does not write).
 */
function rewriteLocked(source, targets) {
  let next = source
  for (const [pkg, version] of targets) {
    const re = new RegExp(`('${escapeRegExp(pkg)}':\\s*')[^']*(')`)
    if (!re.test(next)) fail(`cannot locate the LOCKED entry for ${pkg} in scripts/install-engine.mjs`)
    next = next.replace(re, `$1${version}$2`)
  }
  const today = new Date().toISOString().slice(0, 10)
  next = next.replace(/(registry state verified )\d{4}-\d{2}-\d{2}/, `$1${today}`)
  return next
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const targets = new Map()
  if (args.bump) {
    for (const pkg of PACKAGES) {
      const want = args.explicit !== null && pkg === PACKAGES[0] ? args.explicit : await latestVersion(pkg)
      if (want === null) {
        fail(`cannot resolve the latest version of ${pkg} (registry unreachable?) — re-run with --no-bump to reinstall the pinned versions`)
      }
      targets.set(pkg, want)
    }
    const source = readFileSync(INSTALL_SCRIPT, 'utf8')
    const current = parseLocked(source)
    const changed = [...targets].some(([pkg, want]) => current.get(pkg) !== want)
    for (const [pkg, want] of targets) {
      const before = current.get(pkg)
      console.log(`engine-update: ${pkg}: ${before} → ${want}${before === want ? ' (unchanged)' : ''}`)
    }
    if (!changed) {
      console.log('engine-update: LOCKED already at the latest versions — nothing to bump')
      if (!args.dryRun) console.log('engine-update: skipped install; use --no-bump to force a reinstall of the pinned versions')
      return
    }
    if (args.dryRun) {
      console.log('engine-update: dry-run — LOCKED left untouched, install not run')
      return
    }
    writeFileSync(INSTALL_SCRIPT, rewriteLocked(source, targets))
    console.log('engine-update: LOCKED rewritten in scripts/install-engine.mjs (uncommitted — review with: git diff scripts/install-engine.mjs)')
  } else if (args.dryRun) {
    console.log('engine-update: dry-run with --no-bump — nothing to do')
    return
  }

  const steps = [
    ['install-engine', INSTALL_SCRIPT],
    ['rebuild-engine', REBUILD_SCRIPT],
  ]
  if (args.smoke) steps.push(['smoke', SMOKE_SCRIPT])
  for (const [name, script] of steps) {
    console.log(`engine-update: running ${name} …`)
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: ROOT })
    if (result.status !== 0) {
      fail(`${name} failed (exit ${String(result.status)}) — stopping; the engine tree is in the state that step left it in`)
    }
  }
  console.log('engine-update: done')
}

void main()
