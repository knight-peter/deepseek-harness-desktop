/**
 * Download a GitHub release's syncable artifacts into release/mirror/ using
 * the `gh` CLI, so the GitCode mirror can be completed with
 * `pnpm run sync-domestic --dir release/mirror --tag <tag>`.
 *
 * Why this exists: the domestic machine cannot pull large GitHub assets with
 * plain HTTPS (connection hangs), and the GitHub-CI sync route was removed
 * (US runner cannot reach the Huawei OBS upload domain). `gh release download`
 * is the most reliable CLI path when the network cooperates; the mirror upload
 * itself stays fully automatic (sync-domestic).
 *
 * Only the artifacts sync-domestic can consume are downloaded (dmg/zip/exe/
 * AppImage/latest-*.yml) — blockmaps are skipped.
 *
 * Usage (pnpm forwards args directly, no `--` needed):
 *   pnpm run download-release                    # auto version (package.json)
 *   pnpm run download-release --dir /some/dir
 *
 * Version source: the version is read from package.json's `version` field
 * (the single source of truth after `pnpm run release` — the `v<version>`
 * git tag matches it). No version argument is needed in the normal flow;
 * `--tag <vX.Y.Z>` only exists as an override for exceptional cases.
 * Requires: gh CLI installed and authenticated (`brew install gh` + `gh auth
 * login`).
 * @module dsh-desktop/download-release
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_DIR = join(ROOT, 'release', 'mirror')

function fail(message) {
  console.error(`download-release: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { tag: null, dir: DEFAULT_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = argv[++i] ?? null
    else if (argv[i] === '--dir') args.dir = argv[++i] ?? DEFAULT_DIR
  }
  return args
}

/** Release tag for the current version: `v` + package.json `version`. */
function packageTag() {
  try {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    return typeof version === 'string' && version !== '' ? `v${version}` : null
  } catch {
    return null
  }
}

function sh(command) {
  return execSync(command, { cwd: ROOT, encoding: 'utf8' }).trim()
}

async function main() {
  const { tag: tagArg, dir } = parseArgs(process.argv.slice(2))

  try {
    execSync('gh --version', { stdio: 'ignore' })
  } catch {
    fail('未找到 gh CLI —— 先安装：brew install gh，然后 gh auth login')
  }
  try {
    execSync('gh auth status', { stdio: 'ignore' })
  } catch {
    fail('gh 未登录 —— 先运行 gh auth login')
  }

  const tag = tagArg ?? packageTag()
  if (tag === null) fail('cannot read version from package.json; pass --tag <vX.Y.Z> to override')

  mkdirSync(dir, { recursive: true })
  const patterns = ['*.dmg', '*.zip', '*.exe', '*.AppImage', 'latest-*.yml']
  console.log(`download-release: downloading ${tag} (via gh CLI) → ${dir}`)
  sh(
    `gh release download ${tag} --dir ${JSON.stringify(dir)} --clobber ` +
      patterns.map((p) => `--pattern ${JSON.stringify(p)}`).join(' '),
  )

  const files = readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile()
    } catch {
      return false
    }
  })
  console.log('download-release: downloaded:')
  for (const file of files) console.log(`  ${file}`)
  console.log(`download-release: 下一步：pnpm run sync-domestic --dir ${dir}`)
}

void main().catch((error) => {
  console.error(`download-release: ${String(error.message ?? error)}`)
  process.exit(1)
})
