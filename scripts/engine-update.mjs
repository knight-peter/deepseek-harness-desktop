/**
 * One-command engine update (Phase 2 convenience wrapper).
 *
 * Bumps the pinned engine version in install-engine.mjs (`DEFAULT_ENGINE_VERSION`) to
 * the latest published versions, then runs the standard verification chain
 * (install-engine → rebuild-engine → smoke) against the new pin.
 *
 *   pnpm run engine-update              # default: query npm latest → rewrite
 *                                       # DEFAULT_ENGINE_VERSION (left
 *                                       # uncommitted) → install → rebuild → smoke
 *   pnpm run engine-update --no-bump    # skip the version rewrite — reinstall /
 *                                       # repair with the currently pinned version
 *   pnpm run engine-update --version 0.1.1-rc.2  # pin @deepseek-ai/dsh to an
 *                                       # explicit version
 *   pnpm run engine-update --dry-run    # print old → new without touching anything
 *   pnpm run engine-update --no-smoke   # skip the boot smoke test
 *
 * Design notes:
 *   - LOCAL developer convenience only. CI (build.yml) and the packaged app
 *     (updater:apply) keep calling install-engine.mjs / rebuild-engine.mjs
 *     directly — CI must build the committed default, and the app must never
 *     mutate its (read-only asar) default — it passes DSH_ENGINE_VERSION instead (see src/main/index.ts updater:apply).
 *   - The version rewrite is intentionally NOT committed: it is a source-level
 *     dependency pin and gets the same review/commit discipline as any other
 *     code change. Review with `git diff scripts/install-engine.mjs`.
 *   - Steps reuse the existing scripts unchanged (thin orchestration, no
 *     duplicated logic); the first failing step aborts with its exit code.
 *   - `dsh` is the only version axis: the web frontend follows it through
 *     dsh → dsh-web-app → dsh-web-frontend, so there is nothing else to bump.
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

/**
 * The single engine version axis. The web frontend is NOT pinned alongside it:
 * it resolves transitively through dsh → dsh-web-app → dsh-web-frontend.
 * Pinning it separately (as this script used to) dragged the tree onto a second
 * axis — `dsh-web-frontend` publishes `latest` = 0.0.1-rc.5 while its own
 * dependents require ^0.1.x, so the pin installed an unused copy at the tree
 * root and left `verify()` checking the wrong one.
 */
const ENGINE_PACKAGE = '@deepseek-ai/dsh'

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

const DEFAULT_RE = /const DEFAULT_ENGINE_VERSION\s*=\s*'([^']+)'/

/** Current factory default version read from install-engine.mjs. */
function parseLocked(source) {
  const match = DEFAULT_RE.exec(source)
  if (match === null) fail('cannot locate DEFAULT_ENGINE_VERSION in scripts/install-engine.mjs')
  return match[1]
}

/**
 * Rewrite the DEFAULT_ENGINE_VERSION constant and the "registry state verified
 * <date>" comment in place. Returns the new file content (does not write).
 */
function rewriteLocked(source, version) {
  if (!DEFAULT_RE.test(source)) fail('cannot locate DEFAULT_ENGINE_VERSION in scripts/install-engine.mjs')
  const today = new Date().toISOString().slice(0, 10)
  return source
    .replace(DEFAULT_RE, `const DEFAULT_ENGINE_VERSION = '${version}'`)
    .replace(/(registry state verified )\d{4}-\d{2}-\d{2}/, `$1${today}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.bump) {
    const pkg = ENGINE_PACKAGE
    const want = args.explicit ?? await latestVersion(pkg)
    if (want === null) {
      fail(`cannot resolve the latest version of ${pkg} (registry unreachable?) — re-run with --no-bump to reinstall the pinned version`)
    }
    const source = readFileSync(INSTALL_SCRIPT, 'utf8')
    const before = parseLocked(source)
    console.log(`engine-update: ${pkg}: ${before} → ${want}${before === want ? ' (unchanged)' : ''}`)
    if (before === want) {
      console.log('engine-update: DEFAULT_ENGINE_VERSION already at the latest version — nothing to bump')
      if (!args.dryRun) console.log('engine-update: skipped install; use --no-bump to force a reinstall of the pinned version')
      return
    }
    if (args.dryRun) {
      console.log('engine-update: dry-run — DEFAULT_ENGINE_VERSION left untouched, install not run')
      return
    }
    writeFileSync(INSTALL_SCRIPT, rewriteLocked(source, want))
    console.log('engine-update: DEFAULT_ENGINE_VERSION rewritten in scripts/install-engine.mjs (uncommitted — review with: git diff scripts/install-engine.mjs)')
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
