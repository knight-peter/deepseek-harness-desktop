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
 * Local-artifact skipping (`--skip <spec>`, repeatable): any machine that
 * built its own platform's package for this release can avoid re-downloading
 * those exact bytes — the local files are copied into the mirror dir under
 * the release asset names and excluded from the download. Supported specs:
 *   mac-x64 | mac-arm64   (local release/dsh-desktop-<v>.dmg + -mac.zip →
 *                          -<arch>.dmg / -<arch>-mac.zip; matches `pnpm build`
 *                          on an Intel / Apple Silicon Mac)
 *   win                  (local dsh-desktop-Setup-<v>.exe + latest.yml)
 *   linux                (local dsh-desktop-<v>.AppImage + latest-linux.yml)
 * The copied bytes are guarded by sync-domestic's sha512 verification against
 * the release's latest-*.yml. Without any --skip, the full platform set is
 * downloaded from GitHub.
 *
 * Usage (pnpm forwards args directly, no `--` needed):
 *   pnpm run download-release                    # auto version (package.json)
 *   pnpm run download-release --dir /some/dir
 *   pnpm run download-release --skip mac-x64     # reuse locally-built x64 mac
 *   pnpm run download-release --skip win --skip linux
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RELEASE_DIR = join(ROOT, 'release')
const DEFAULT_DIR = join(RELEASE_DIR, 'mirror')

function fail(message) {
  console.error(`download-release: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { tag: null, dir: DEFAULT_DIR, skip: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = argv[++i] ?? null
    else if (argv[i] === '--dir') args.dir = argv[++i] ?? DEFAULT_DIR
    else if (argv[i] === '--skip') args.skip.push(argv[++i] ?? '')
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

/** Local single-arch build output → mirror asset names, per --skip group. */
const SKIP_GROUPS = {
  'mac-x64': {
    locals: [
      { local: (v) => `dsh-desktop-${v}.dmg`, remote: (v) => `dsh-desktop-${v}-x64.dmg` },
      { local: (v) => `dsh-desktop-${v}-mac.zip`, remote: (v) => `dsh-desktop-${v}-x64-mac.zip` },
    ],
  },
  'mac-arm64': {
    locals: [
      { local: (v) => `dsh-desktop-${v}.dmg`, remote: (v) => `dsh-desktop-${v}-arm64.dmg` },
      { local: (v) => `dsh-desktop-${v}-mac.zip`, remote: (v) => `dsh-desktop-${v}-arm64-mac.zip` },
    ],
  },
  win: {
    locals: [
      { local: (v) => `dsh-desktop-Setup-${v}.exe`, remote: (v) => `dsh-desktop-Setup-${v}.exe` },
      { local: () => 'latest.yml', remote: () => 'latest.yml' },
    ],
  },
  linux: {
    locals: [
      { local: (v) => `dsh-desktop-${v}.AppImage`, remote: (v) => `dsh-desktop-${v}.AppImage` },
      { local: () => 'latest-linux.yml', remote: () => 'latest-linux.yml' },
    ],
  },
}

/**
 * Copy the local artifacts of every `--skip`ed group into the mirror dir and
 * return the set of skipped groups. Fails when a group's local files are
 * missing — skipping must never silently leave a hole in the mirror.
 */
function copyLocalArtifacts(dir, version, specs) {
  const skipped = new Set()
  for (const spec of specs) {
    const group = SKIP_GROUPS[spec]
    if (group === undefined) {
      fail(`--skip 只支持 ${Object.keys(SKIP_GROUPS).join(' / ')}，收到：${spec}`)
    }
    for (const { local, remote } of group.locals) {
      const src = join(RELEASE_DIR, local(version))
      if (!existsSync(src)) {
        fail(`--skip ${spec}：缺少本地产物 ${local(version)}——请先在本机构建，或不要跳过该平台`)
      }
      copyFileSync(src, join(dir, remote(version)))
      console.log(`download-release: local ${local(version)} → ${remote(version)} (copied, no download)`)
    }
    skipped.add(spec)
  }
  return skipped
}

/** gh include patterns: exact mac per-arch names + win/linux/yml, minus skipped groups. */
export function buildPatterns(version, skipped) {
  const patterns = []
  for (const arch of ['arm64', 'x64']) {
    if (skipped.has(`mac-${arch}`)) continue
    patterns.push(`dsh-desktop-${version}-${arch}.dmg`, `dsh-desktop-${version}-${arch}-mac.zip`)
  }
  if (!skipped.has('win')) patterns.push('*.exe', 'latest.yml')
  if (!skipped.has('linux')) patterns.push('*.AppImage', 'latest-linux.yml')
  patterns.push('latest-mac.yml')
  return patterns
}

/**
 * The GitHub repo to hand gh as `--repo`, or null to let gh infer it (from
 * `GH_REPO` env of OWNER/REPO form, else the git remote of the working dir).
 *
 * The project's `.env` sets `GH_REPO` to the REPO-NAME ONLY (that is the
 * shape electron-builder's `${env.GH_REPO}` macro needs), which gh rejects
 * with "expected the [HOST/]OWNER/REPO format". `release-all` loads .env and
 * spawns this script with that env inherited, so the gh call must resolve an
 * explicit OWNER/REPO from `GH_OWNER` + `GH_REPO` whenever both are present.
 */
export function ghRepoFlag() {
  const owner = process.env.GH_OWNER ?? ''
  const repo = process.env.GH_REPO ?? ''
  if (repo === '') return ''
  const qualified = repo.includes('/') ? repo : owner === '' ? '' : `${owner}/${repo}`
  return qualified === '' ? '' : `--repo ${JSON.stringify(qualified)} `
}

async function main() {
  const { tag: tagArg, dir, skip } = parseArgs(process.argv.slice(2))

  try {
    execSync('gh --version', { stdio: 'ignore' })
  } catch {
    fail('未找到 gh CLI —— 先安装：brew install gh，然后 gh auth login')
  }
  try {
    execSync('gh auth status', { stdio: 'ignore' })
  } catch {
    // gh auth status exits non-zero when a stale/invalid stored credential
    // exists (hosts.yml) even though GH_TOKEN is valid — the release flow
    // always carries GH_TOKEN, so fall back to an isolated config dir where
    // gh uses the env token only.
    if (process.env.GH_TOKEN !== undefined && process.env.GH_TOKEN !== '') {
      const iso = join(ROOT, 'release', '.ghcfg')
      mkdirSync(iso, { recursive: true })
      process.env.GH_CONFIG_DIR = iso
      try {
        execSync('gh auth status', { stdio: 'ignore' })
      } catch {
        fail('gh 认证失败（隔离配置下也不可用）——请检查 GH_TOKEN 是否有效')
      }
    } else {
      fail('gh 未登录 —— 先运行 gh auth login，或设置 GH_TOKEN')
    }
  }

  const tag = tagArg ?? packageTag()
  if (tag === null) fail('cannot read version from package.json; pass --tag <vX.Y.Z> to override')

  mkdirSync(dir, { recursive: true })
  const version = tag.replace(/^v/, '')

  // --skip <spec>: copy this machine's locally-built platform artifacts into
  // the mirror dir instead of re-downloading them. No --skip → full download.
  const skipped = copyLocalArtifacts(dir, version, skip)
  const patterns = buildPatterns(version, skipped)
  if (skipped.size > 0) {
    console.log(`download-release: skipping download of: ${[...skipped].join(', ')}`)
  }
  console.log(`download-release: downloading ${tag} (via gh CLI) → ${dir}`)
  sh(
    `gh release download ${ghRepoFlag()}${tag} --dir ${JSON.stringify(dir)} --clobber ` +
      patterns.map((p) => `--pattern ${JSON.stringify(p)}`).join(' '),
  )

  const kept = cleanStaleArtifacts(dir, version)

  console.log('download-release: downloaded:')
  for (const file of kept) console.log(`  ${file}`)
  console.log(`download-release: 下一步：pnpm run sync-domestic --dir ${dir}`)
}

/**
 * Remove `dsh-desktop-*` artifacts of older releases from the mirror dir and
 * return the remaining file names. Only the current version's files are kept,
 * so sync-domestic --dir never uploads stale artifacts (e.g. the previous
 * release's Setup-0.1.3.exe) to the GitCode `latest` mirror.
 */
export function cleanStaleArtifacts(dir, version) {
  const currentRe = new RegExp(`-${version.replace(/\./g, '\\.')}([.-])`)
  for (const name of readdirSync(dir)) {
    if (!/^dsh-desktop-/.test(name) || currentRe.test(name)) continue
    rmSync(join(dir, name), { force: true })
    console.log(`download-release: removed stale ${name}`)
  }
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile()
    } catch {
      return false
    }
  })
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(`download-release: ${String(error.message ?? error)}`)
    process.exit(1)
  })
}
