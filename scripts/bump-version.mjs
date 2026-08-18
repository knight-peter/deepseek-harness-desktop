/**
 * Bump the release version, tag it and push — the single entry point for
 * starting the release pipeline.
 *
 *   node scripts/bump-version.mjs            # v0.1.0 → v0.1.1 (patch)
 *   node scripts/bump-version.mjs --minor    # v0.1.0 → v0.2.0
 *   node scripts/bump-version.mjs --major    # v0.1.0 → v1.0.0
 *   node scripts/bump-version.mjs --version 0.3.0   # explicit
 *   pnpm run release --minor                 # same, via pnpm (pnpm forwards
 *                                            # args directly, no `--` needed)
 *
 * Behaviour:
 *   - Reads the latest `v*` git tag (or package.json version if no tag yet).
 *   - Computes the next version per the bump level (default: patch).
 *   - Writes package.json `version`, git-commits it as
 *     `release: v<next>`, creates tag `v<next>` and pushes both.
 *   - The tag push triggers the CI build+release (see workflow `on.push.tags`).
 *   - After CI finishes, run `pnpm run publish-x64 --tag v<next>` locally.
 *
 * Safe-guards: refuses to run with uncommitted changes; refuses to overwrite
 * an existing tag; requires git remote `origin`.
 * @module dsh-desktop/bump-version
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PKG = join(ROOT, 'package.json')

function fail(message) {
  console.error(`bump-version: ${message}`)
  process.exit(1)
}

function sh(command) {
  return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  const args = { level: 'patch', explicit: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--minor') args.level = 'minor'
    else if (argv[i] === '--major') args.level = 'major'
    else if (argv[i] === '--version') args.explicit = argv[++i] ?? null
  }
  if (args.explicit !== null && !/^\d+\.\d+\.\d+$/.test(args.explicit)) {
    fail(`invalid --version "${args.explicit}" (expected x.y.z)`)
  }
  return args
}

/** Parse `v1.2.3` → [1, 2, 3]; null when not a semantic version. */
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Latest v* tag across local+remote refs, or null. */
function latestTag() {
  try {
    const tags = sh('git tag --list "v*" --sort=-v:refname')
      .split('\n')
      .filter(Boolean)
    return tags[0] ?? null
  } catch {
    return null
  }
}

function bump(current, level) {
  const [major, minor, patch] = current
  switch (level) {
    case 'major':
      return [major + 1, 0, 0]
    case 'minor':
      return [major, minor + 1, 0]
    default:
      return [major, minor, patch + 1]
  }
}

async function main() {
  const { level, explicit } = parseArgs(process.argv.slice(2))

  // Guard: clean working tree (version bump + tag must be the only change).
  const dirty = sh('git status --porcelain')
  if (dirty !== '') fail(`working tree not clean:\n${dirty}`)

  // Determine current version: latest v* tag wins, else package.json.
  const tag = latestTag()
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  const current = tag !== null ? parseVersion(tag) : parseVersion(pkg.version)
  if (current === null) {
    fail(`cannot parse current version (tag=${tag ?? 'none'}, package.json=${pkg.version})`)
  }

  const next = explicit !== null ? parseVersion(explicit) : bump(current, level)
  if (next === null) fail(`cannot parse target version`)
  const nextTag = `v${next.join('.')}`

  // Guard: target tag must not exist.
  const existing = sh(`git tag --list "${nextTag}"`)
  if (existing !== '') fail(`tag ${nextTag} already exists`)

  console.log(`bump-version: ${current.join('.')} → ${next.join('.')} (${explicit !== null ? 'explicit' : level})`)

  // Update package.json version.
  pkg.version = next.join('.')
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`)

  // Commit + tag + push (tag push triggers the CI release pipeline).
  sh(`git add package.json`)
  sh(`git commit -m "release: v${next.join('.')}"`)
  sh(`git tag ${nextTag}`)
  sh(`git push origin HEAD`)
  sh(`git push origin ${nextTag}`)

  console.log(`bump-version: committed + pushed v${next.join('.')}`)
  console.log(`bump-version: CI is building & will create the release.`)
  console.log(`bump-version: when CI is green, run:`)
  console.log(`  pnpm run publish-x64 --tag v${next.join('.')}`)
}

void main()
