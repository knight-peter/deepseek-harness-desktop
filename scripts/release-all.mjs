/**
 * One-command full release pipeline (发布全流程) — no human/AI glue needed
 * between steps:
 *
 *   pnpm run release-all                  # default: patch bump
 *   pnpm run release-all --minor          # minor bump
 *   pnpm run release-all --version 1.2.3  # explicit version
 *   pnpm run release-all --skip-build     # local artifacts already built
 *   pnpm run release-all --skip-mirror    # do not sync the GitCode mirror
 *   pnpm run release-all --skip mac-x64   # forward to download-release (see
 *                                         # its --skip docs); Intel Macs pass
 *                                         # mac-x64 automatically after building
 *   pnpm run release-all --dry-run        # preflight only, no side effects
 *
 * Sequence (each step waits for the previous, fails fast with a rerun hint):
 *   1. bump-version.mjs — bump package.json, commit `release: vX.Y.Z`, tag
 *      and push to origin (the tag push triggers the CI build+release).
 *   2. Wait for the CI workflow run on the new tag to finish successfully
 *      (polls the GitHub Actions API; timeout via RELEASE_CI_TIMEOUT_MS).
 *   3. Wait for the draft GitHub release created by CI to exist.
 *   4. Local `pnpm build` on an Intel Mac (x64 artifacts) — skipped when the
 *      version's dmg+zip already exist in release/ or on non-x64 hosts.
 *   5. publish-release.mjs — publish the draft; with `--with-x64` on an Intel
 *      Mac (uploads the local x64 artifacts, merges latest-mac.yml, verifies
 *      completeness, then publishes).
 *   6. download-release.mjs — fetch the full platform set into release/mirror
 *      (reuses local x64 artifacts instead of re-downloading; drops stale
 *      older-version files).
 *   7. sync-domestic.mjs --dir release/mirror — upload to the GitCode mirror
 *      (skipped with a warning when GitCode credentials are missing).
 *
 * Requirements: GH_TOKEN / GH_OWNER / GH_REPO (GitHub), GITCODE_TOKEN /
 * GITCODE_OWNER / GITCODE_REPO (GitCode mirror; optional), gh CLI (download
 * step), and a clean working tree. Credentials are loaded from
 * .env → .env.development → .env.local by the `release-all` npm script.
 * @module dsh-desktop/release-all
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const API = 'https://api.github.com'
const TOKEN = process.env.GH_TOKEN ?? ''
const OWNER = process.env.GH_OWNER ?? ''
const REPO = process.env.GH_REPO ?? ''
// CI can take ~15-30 min across three platforms; 120 min is a safe ceiling.
const CI_TIMEOUT_MS = Number(process.env.RELEASE_CI_TIMEOUT_MS ?? 120 * 60_000)
const POLL_MS = Number(process.env.RELEASE_POLL_MS ?? 30_000)

function fail(message) {
  console.error(`release-all: ${message}`)
  process.exit(1)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) fail(`命令失败（exit ${String(result.status)}）：${cmd} ${args.join(' ')}`)
}

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

/** The machine's own single-arch mac artifacts already built in release/. */
function localArtifactsExist(version) {
  return (
    existsSync(join(ROOT, 'release', `dsh-desktop-${version}.dmg`)) &&
    existsSync(join(ROOT, 'release', `dsh-desktop-${version}-mac.zip`))
  )
}

async function gh(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} on ${path}: ${body.slice(0, 200)}`)
  }
  return response.json()
}

/** Retry a flaky GitHub API read until the CI deadline. */
async function withRetry(fn, label) {
  const deadline = Date.now() + CI_TIMEOUT_MS
  for (;;) {
    try {
      return await fn()
    } catch (error) {
      if (Date.now() > deadline) fail(`${label} 持续失败：${String(error.message ?? error)}`)
      console.log(`[release-all] ${label} 网络错误，10s 后重试：${String(error.message ?? error).slice(0, 120)}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))
    }
  }
}

/** The CI workflow run triggered by the tag push (head_branch = tag name). */
export async function findCiRun(tag) {
  const data = await gh(`/repos/${OWNER}/${REPO}/actions/runs?event=push&per_page=50`)
  return (data.workflow_runs ?? []).find(
    (r) => r.head_branch === tag && (r.display_title ?? '').startsWith('release: v'),
  ) ?? null
}

/** The GitHub release for the tag (drafts are only visible in the list). */
export async function findRelease(tag) {
  const data = await gh(`/repos/${OWNER}/${REPO}/releases?per_page=100`)
  return (data ?? []).find((r) => r.tag_name === tag) ?? null
}

async function waitForCi(tag) {
  console.log(`[release-all] ⏳ 等待 CI 构建成功（tag ${tag}，超时 ${Math.round(CI_TIMEOUT_MS / 60_000)} 分钟）`)
  const deadline = Date.now() + CI_TIMEOUT_MS
  for (;;) {
    const run = await withRetry(() => findCiRun(tag), `查询 CI run ${tag}`)
    if (run !== null && run.status === 'completed') {
      if (run.conclusion !== 'success') fail(`CI 失败（conclusion=${run.conclusion}）：${run.html_url}`)
      console.log(`[release-all] ✅ CI 成功（run ${run.id}）`)
      return
    }
    if (Date.now() > deadline) fail(`等待 CI 超时（${Math.round(CI_TIMEOUT_MS / 60_000)} 分钟）——请到 GitHub Actions 查看 ${tag}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS))
  }
}

async function waitForDraft(tag) {
  console.log(`[release-all] ⏳ 等待 CI 创建的 draft release（${tag}）`)
  const deadline = Date.now() + CI_TIMEOUT_MS
  for (;;) {
    const release = await withRetry(() => findRelease(tag), `查询 release ${tag}`)
    if (release !== null) {
      console.log(`[release-all] ✅ draft release 就绪（id ${release.id}，draft=${release.draft}）`)
      return
    }
    if (Date.now() > deadline) fail(`等待 draft release 超时——CI 可能没有创建 release`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS))
  }
}

function preflight() {
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty !== '') fail(`工作区有未提交改动，请先提交或 stash：\n${dirty}`)
  if (TOKEN === '' || OWNER === '' || REPO === '') fail('缺少 GH_TOKEN / GH_OWNER / GH_REPO（分别来自 .env.local 与 .env）')
  let ghOk = false
  try {
    execSync('gh --version', { stdio: 'ignore' })
    ghOk = true
  } catch {
    ghOk = false
  }
  if (!ghOk) fail('未找到 gh CLI —— 先安装：brew install gh')
  const gitcodeOk =
    process.env.GITCODE_TOKEN !== undefined && process.env.GITCODE_TOKEN !== '' &&
    process.env.GITCODE_OWNER !== undefined && process.env.GITCODE_OWNER !== '' &&
    process.env.GITCODE_REPO !== undefined && process.env.GITCODE_REPO !== ''
  if (!gitcodeOk) {
    console.warn('[release-all] ⚠️ GITCODE_TOKEN / GITCODE_OWNER / GITCODE_REPO 缺失——将跳过 GitCode 镜像同步（可用 --skip-mirror 显式声明）')
  }
  console.log('[release-all] ✅ 前置检查通过')
  return gitcodeOk
}

function parseArgs(argv) {
  const bumpArgs = []
  const flags = { skipBuild: false, skipMirror: false, dryRun: false, skip: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--minor' || argv[i] === '--major') bumpArgs.push(argv[i])
    else if (argv[i] === '--version') bumpArgs.push('--version', argv[++i] ?? '')
    else if (argv[i] === '--skip-build') flags.skipBuild = true
    else if (argv[i] === '--skip-mirror') flags.skipMirror = true
    else if (argv[i] === '--skip') flags.skip.push(argv[++i] ?? '')
    else if (argv[i] === '--dry-run') flags.dryRun = true
    else fail(`未知参数：${argv[i]}`)
  }
  return { bumpArgs, flags }
}

async function main() {
  const { bumpArgs, flags } = parseArgs(process.argv.slice(2))
  const mirrorOk = preflight()
  const currentTag = `v${readVersion()}`
  console.log(`[release-all] 当前版本：${readVersion()}（tag ${currentTag}）`)

  if (flags.dryRun) {
    console.log('[release-all] --dry-run：仅前置检查，不执行。后续将按序执行：')
    console.log(`  1. bump-version.mjs ${bumpArgs.join(' ') || '(patch)'} → commit + tag + push（触发 CI）`)
    console.log('  2. 轮询 GitHub Actions 直到 CI 成功')
    console.log('  3. 等待 CI 创建的 draft release')
    console.log(`  4. 本机 pnpm build（Intel Mac 且产物缺失时）——当前 ${process.platform === 'darwin' ? `Mac/${process.arch}` : `${process.platform}/${process.arch}`}`)
    console.log(`  5. publish-release.mjs ${process.platform === 'darwin' && process.arch === 'x64' ? '--with-x64' : ''}`)
    console.log(`  6. download-release.mjs → release/mirror（--skip ${[...flags.skip, '(Intel Mac 自动 mac-x64)'].join(' ')}）`)
    console.log(`  7. sync-domestic.mjs --dir release/mirror（${mirrorOk ? '启用' : '跳过：凭据缺失'}）`)
    return
  }

  // 1. bump + commit + tag + push（触发 CI）
  run(process.execPath, [join(ROOT, 'scripts', 'bump-version.mjs'), ...bumpArgs])
  const newTag = `v${readVersion()}`
  const version = newTag.slice(1)
  console.log(`[release-all] ✅ 已推送 tag ${newTag}，CI 即将开始`)

  // 2-3. wait for CI + draft release
  await waitForCi(newTag)
  await waitForDraft(newTag)

  // 4. local build (Intel Mac only, when the version's artifacts are missing)
  const isMacX64 = process.platform === 'darwin' && process.arch === 'x64'
  if (!flags.skipBuild && isMacX64 && !localArtifactsExist(version)) {
    console.log('[release-all] 🏗️  本机构建 x64 mac 产物（pnpm build）')
    run('pnpm', ['build'])
  } else {
    console.log(`[release-all] 跳过本机构建（${flags.skipBuild ? '--skip-build' : isMacX64 ? '产物已存在' : '非 Intel Mac 主机，x64 由本机负责'}）`)
  }

  // 5. publish (with x64 merge on Intel Mac)
  console.log('[release-all] 📦 发布 draft release（并合并本机产物）')
  run(process.execPath, [join(ROOT, 'scripts', 'publish-release.mjs'), ...(isMacX64 ? ['--with-x64'] : [])])

  // 6. download full platform set into release/mirror (skip platforms this
  //    machine built locally: Intel Mac auto-passes mac-x64; --skip forwards)
  const downloadSkip = [...flags.skip]
  if (isMacX64 && localArtifactsExist(version) && !downloadSkip.includes('mac-x64')) {
    downloadSkip.push('mac-x64')
  }
  const downloadArgs = downloadSkip.flatMap((s) => ['--skip', s])
  console.log(`[release-all] ⬇️  下载全平台产物到 release/mirror（跳过：${downloadSkip.length > 0 ? downloadSkip.join(', ') : '无'}）`)
  run(process.execPath, [join(ROOT, 'scripts', 'download-release.mjs'), ...downloadArgs])

  // 7. GitCode mirror
  if (!flags.skipMirror && mirrorOk) {
    console.log('[release-all] 🪞 同步 GitCode 镜像')
    run(process.execPath, [join(ROOT, 'scripts', 'sync-domestic.mjs'), '--dir', join(ROOT, 'release', 'mirror')])
  } else {
    console.log(`[release-all] 跳过 GitCode 镜像同步（${flags.skipMirror ? '--skip-mirror' : '凭据缺失'}）——可稍后手动：pnpm run sync-domestic --dir release/mirror`)
  }

  console.log('\n[release-all] 🎉 发布全流程完成')
  console.log(`  GitHub  Releases：https://github.com/${OWNER}/${REPO}/releases/tag/${newTag}`)
  if (process.env.GITCODE_OWNER !== undefined && process.env.GITCODE_REPO !== undefined) {
    console.log(`  GitCode 镜像：https://gitcode.com/${process.env.GITCODE_OWNER}/${process.env.GITCODE_REPO}/releases`)
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(`release-all: ${String(error.message ?? error)}`)
    process.exit(1)
  })
}
