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
 * Transport strategy (cross-platform): the `gh` CLI is used when it is
 * installed AND authenticated (preferred). Otherwise the script falls back to
 * GH_TOKEN + GitHub REST API + `curl` with resume (`-C -`) and retry — every
 * supported OS ships curl (macOS built-in, Linux ~always, Windows 10+ ships
 * curl.exe). The fallback needs only the two release env vars, no interactive
 * `gh auth login`, so the mirror step runs on any machine with git+node+curl.
 * Optional `DSH_MIRROR_PROXY` forces a proxy (`-x`); without it curl honors
 * the standard HTTPS_PROXY/HTTP_PROXY env vars.
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
 * Requires: gh CLI installed+authenticated (gh path), or GH_TOKEN +
 * GH_OWNER/GH_REPO (fallback path; curl for downloads).
 * @module dsh-desktop/download-release
 */

import { execSync, spawnSync } from 'node:child_process'
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

export function parseArgs(argv) {
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
  const qualified = repoQualified()
  return qualified === null ? '' : `--repo ${JSON.stringify(qualified)} `
}

/** `owner/repo` for the GitHub API, or null when GH_OWNER/GH_REPO are missing. */
function repoQualified() {
  const owner = process.env.GH_OWNER ?? ''
  const repo = process.env.GH_REPO ?? ''
  if (repo === '') return null
  return repo.includes('/') ? repo : owner === '' ? null : `${owner}/${repo}`
}

/**
 * Whether the `gh` CLI is usable: installed AND authenticated. A stale stored
 * credential (hosts.yml) can fail `gh auth status` even though GH_TOKEN is
 * valid — the release flow always carries GH_TOKEN, so retry once with an
 * isolated config dir where gh uses the env token only.
 */
export function ghUsable() {
  try {
    execSync('gh --version', { stdio: 'ignore' })
  } catch {
    return false
  }
  try {
    execSync('gh auth status', { stdio: 'ignore' })
    return true
  } catch {
    if (process.env.GH_TOKEN === undefined || process.env.GH_TOKEN === '') return false
    const iso = join(ROOT, 'release', '.ghcfg')
    mkdirSync(iso, { recursive: true })
    process.env.GH_CONFIG_DIR = iso
    try {
      execSync('gh auth status', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

/** Convert a gh `--pattern` glob into a RegExp (patterns never use `**`/`[]`). */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

/**
 * GH_TOKEN + GitHub REST API + curl fallback (gh-free, cross-platform).
 * Lists the release assets via the API, downloads each with curl using
 * resume (`-C -`), retries and a size check against the asset metadata.
 */
async function downloadViaToken(dir, tag, version, patterns) {
  const qualified = repoQualified()
  if (qualified === null) fail('GH_TOKEN 回退路径需要 GH_OWNER + GH_REPO（或 GH_REPO=owner/repo）环境变量')
  const token = process.env.GH_TOKEN
  if (token === undefined || token === '') fail('GH_TOKEN 未设置 —— 无法走 token 回退路径')
  const matchers = patterns.map(globToRegExp)
  const curlArgs = ['-sL', '-C', '-', '--retry', '3', '--retry-delay', '3', '--retry-all-errors', '--max-time', '900']
  const proxy = process.env.DSH_MIRROR_PROXY
  if (proxy !== undefined && proxy !== '') curlArgs.push('-x', proxy)

  const response = await fetch(`https://api.github.com/repos/${qualified}/releases/tags/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'dsh-download-release' },
  })
  const release = await response.json()
  if (!Array.isArray(release.assets)) {
    fail(`GitHub API 未返回 release ${tag}（HTTP ${response.status}）——请检查 GH_TOKEN / GH_OWNER / GH_REPO`)
  }
  const assets = release.assets.filter((asset) => matchers.some((m) => m.test(asset.name)))
  if (assets.length === 0) fail(`release ${tag} 没有可同步的产物（已按 --skip 过滤）`)

  for (const asset of assets) {
    const dest = join(dir, asset.name)
    let got = (() => { try { return statSync(dest).size } catch { return 0 } })()
    if (got === asset.size) {
      console.log(`download-release: ${asset.name} already complete (${asset.size} bytes), skip`)
      continue
    }
    console.log(`download-release: downloading ${asset.name} (${(asset.size / 1048576).toFixed(0)} MB)${got > 0 ? `, resuming at ${got}` : ''} (GH_TOKEN + curl)`)
    let attempts = 0
    while (got !== asset.size && attempts < 6) {
      attempts++
      const result = spawnSync('curl', [...curlArgs, '-o', dest, asset.browser_download_url], {
        encoding: 'utf8',
        timeout: 950_000,
      })
      try {
        got = statSync(dest).size
      } catch {
        got = 0
      }
      if (got !== asset.size) {
        console.log(`download-release:   attempt ${attempts} incomplete (${got}/${asset.size} bytes, curl status ${String(result.status)})`)
      }
    }
    if (got !== asset.size) fail(`下载失败：${asset.name}（${got}/${asset.size} 字节）`)
    console.log(`download-release:   done ${(asset.size / 1048576).toFixed(0)} MB`)
  }
}

async function main() {
  const { tag: tagArg, dir, skip } = parseArgs(process.argv.slice(2))

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

  // Transport: gh CLI preferred; GH_TOKEN + REST API + curl as the
  // cross-platform fallback (no interactive `gh auth login` needed).
  if (ghUsable()) {
    console.log(`download-release: downloading ${tag} (via gh CLI) → ${dir}`)
    sh(
      `gh release download ${ghRepoFlag()}${tag} --dir ${JSON.stringify(dir)} --clobber ` +
        patterns.map((p) => `--pattern ${JSON.stringify(p)}`).join(' '),
    )
  } else if (process.env.GH_TOKEN !== undefined && process.env.GH_TOKEN !== '') {
    console.log(`download-release: gh CLI 不可用，改用 GH_TOKEN + GitHub API + curl → ${dir}`)
    await downloadViaToken(dir, tag, version, patterns)
  } else {
    fail('既没有可用的 gh CLI（未安装/未登录），也没有 GH_TOKEN —— 二选一：安装并 gh auth login，或设置 GH_TOKEN')
  }

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
