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
 *   pnpm run download-release                    # auto tag (latest v* git tag)
 *   pnpm run download-release --tag v0.1.1       # explicit version
 *   pnpm run download-release --tag v0.1.1 --dir /some/dir
 *
 * Requires: gh CLI installed and authenticated (`brew install gh` + `gh auth
 * login`).
 * @module dsh-desktop/download-release
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
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

/** Latest `v*` git tag (local+remote), or null when none exists. */
function latestTag() {
  try {
    const tags = execSync('git tag --list "v*" --sort=-v:refname', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    return tags[0] ?? null
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

  const tag = tagArg ?? latestTag()
  if (tag === null) fail('no --tag given and no v* git tag found; pass --tag <vX.Y.Z>')

  mkdirSync(dir, { recursive: true })
  const patterns = ['*.dmg', '*.zip', '*.exe', '*.AppImage', 'latest-*.yml']
  console.log(`download-release: downloading ${tag} (via gh CLI) → ${dir}`)
  sh(
    `gh release download ${tag} --dir ${JSON.stringify(dir)} ` +
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
  console.log(`download-release: 下一步：pnpm run sync-domestic --dir ${dir} --tag ${tag}`)
}

void main().catch((error) => {
  console.error(`download-release: ${String(error.message ?? error)}`)
  process.exit(1)
})
