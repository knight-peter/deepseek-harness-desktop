/**
 * Publish the locally-built macOS artifacts of one architecture into the
 * GitHub release that CI created for the other architecture, and merge the
 * entries into latest-mac.yml so electron-updater can serve both.
 *
 * Background (see docs/开发总结.md §4.6): the CI mac runner (macos-15) is
 * arm64 and ships the Apple Silicon package; there is no Intel macOS runner
 * on GitHub anymore (macos-13 retired), so the x64 package is built locally
 * (`pnpm build` on an Intel Mac) and merged here. electron-updater matches
 * files by the architecture string in the file name, so artifacts must be
 * uploaded under arch-suffixed names (`dsh-desktop-<v>-x64.dmg` / `-arm64`).
 *
 * Usage:
 *   GH_TOKEN=<token> node scripts/publish-x64.mjs --tag v0.1.0
 *   GH_TOKEN=<token> node scripts/publish-x64.mjs --tag v0.1.0 --arch arm64
 *
 * The local artifacts are read from `release/` (as produced by `pnpm build`,
 * which names single-arch output without a suffix) and uploaded under the
 * arch-suffixed name. Requires a GitHub token with `repo` scope; the target
 * release must already exist (created by CI's publish step).
 * @module dsh-desktop/publish-x64
 */

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RELEASE_DIR = join(ROOT, 'release')

const API = 'https://api.github.com'
const TOKEN = process.env.GH_TOKEN
const OWNER = process.env.GH_OWNER
const REPO = process.env.GH_REPO

if (OWNER === undefined || OWNER === '' || REPO === undefined || REPO === '') {
  fail('GH_OWNER / GH_REPO must be set (defined in .env; loaded via --env-file-if-exists)')
}

function fail(message) {
  console.error(`publish-x64: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { tag: null, arch: 'x64' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = argv[++i] ?? null
    else if (argv[i] === '--arch') args.arch = argv[++i] ?? 'x64'
  }
  if (args.arch !== 'x64' && args.arch !== 'arm64') fail(`unsupported --arch ${args.arch} (x64|arm64)`)
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

async function gh(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers ?? {}),
  }
  const response = await fetch(`${API}${path}`, { ...options, headers })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} on ${path}: ${body.slice(0, 300)}`)
  }
  return response.status === 204 ? null : response.json()
}

/** sha512 (base64) + byte size of a local file. */
function artifactInfo(filePath) {
  const data = readFileSync(filePath)
  return { sha512: createHash('sha512').update(data).digest('base64'), size: data.length }
}

/**
 * Resolve the release by tag; returns id + upload_url without the template
 * suffix. GitHub's `/releases/tags/<tag>` endpoint 404s for DRAFT releases
 * (a known API limitation), so fall back to listing `/releases` and matching
 * by tag_name — drafts are included there.
 */
async function getRelease(tag) {
  const byTag = await gh(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`).catch(() => null)
  const release = byTag ?? (await gh(`/repos/${OWNER}/${REPO}/releases?per_page=100`)).find((r) => r.tag_name === tag)
  if (release === undefined || release === null) {
    throw new Error(`release ${tag} not found`)
  }
  return { id: release.id, uploadUrl: release.upload_url.replace(/\{[^}]*\}$/, '') }
}

/**
 * Verify the release carries the full set of platform artifacts and update
 * metadata. Prints a summary and warns about any missing piece — the
 * publisher stays responsible for deciding whether missing pieces are OK
 * (e.g. a draft/in-progress release).
 *
 * Expected per platform (version `vX.Y.Z`):
 *   mac arm64:  dsh-desktop-<v>-arm64.dmg, dsh-desktop-<v>-arm64-mac.zip
 *   mac x64:    dsh-desktop-<v>-x64.dmg,    dsh-desktop-<v>-x64-mac.zip
 *   windows:    *.exe (nsis) + latest.yml
 *   linux:      *.AppImage + latest-linux.yml
 *   mac update: latest-mac.yml
 */
async function verifyRelease(releaseId, tag, version) {
  const assets = await gh(`/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?per_page=100`)
  const names = assets.map((a) => a.name)
  const has = (pattern) => names.some((n) => pattern.test(n))
  const missing = []
  const report = (label, present) => {
    console.log(`publish-x64:   ${present ? '✓' : '✗'} ${label}`)
    if (!present) missing.push(label)
  }

  console.log(`publish-x64: release ${tag} completeness:`)
  report(`mac arm64 dmg (${version}-arm64.dmg)`, has(new RegExp(`dsh-desktop-${version}-arm64\\.dmg$`)))
  report(`mac arm64 zip (${version}-arm64-mac.zip)`, has(new RegExp(`dsh-desktop-${version}-arm64-mac\\.zip$`)))
  report(`mac x64 dmg (${version}-x64.dmg)`, has(new RegExp(`dsh-desktop-${version}-x64\\.dmg$`)))
  report(`mac x64 zip (${version}-x64-mac.zip)`, has(new RegExp(`dsh-desktop-${version}-x64-mac\\.zip$`)))
  report('windows nsis (.exe)', has(/\.exe$/))
  report('linux AppImage', has(/\.AppImage$/))
  report('latest-mac.yml (update metadata)', has(/^latest-mac\.yml$/))
  report('latest.yml (windows update metadata)', has(/^latest\.yml$/))
  report('latest-linux.yml (linux update metadata)', has(/^latest-linux\.yml$/))

  if (missing.length > 0) {
    console.warn(`publish-x64: ⚠️ release ${tag} is MISSING: ${missing.join(', ')}`)
    console.warn('publish-x64:   CI may still be running, or a platform failed. Verify before announcing the release.')
  } else {
    console.log(`publish-x64: ✅ release ${tag} is complete (mac x64+arm64 / windows / linux / update metadata)`)
  }
  return missing
}

/**
 * Upload a binary asset to GitHub's uploads endpoint over HTTP/1.1 with
 * retry. Node's fetch (undici) negotiates HTTP/2, which GitHub's upload
 * endpoint aborts mid-transfer for large files (ERR_HTTP2_STREAM_ERROR);
 * HTTP/1.1 uploads large assets reliably. 422 = name collision (already
 * uploaded) → treated as success/skip.
 */
function uploadHttp1(uploadUrl, assetName, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl)
    url.searchParams.set('name', assetName)
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': data.length,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode === 201 || res.statusCode === 200) {
            resolve({ ok: true, status: res.statusCode, body })
          } else if (res.statusCode === 422) {
            resolve({ ok: false, status: 422, body })
          } else {
            resolve({ ok: false, status: res.statusCode ?? 0, body })
          }
        })
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function uploadAsset(uploadUrl, assetName, data) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await uploadHttp1(uploadUrl, assetName, data)
      if (result.ok) {
        console.log(`publish-x64: uploaded ${assetName}`)
        return
      }
      if (result.status === 422) {
        console.log(`publish-x64: asset ${assetName} already exists — skipping`)
        return
      }
      throw new Error(`upload ${assetName} failed: ${result.status} ${result.body.slice(0, 300)}`)
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`publish-x64: upload ${assetName} attempt ${attempt} failed (${String(error.message ?? error).slice(0, 120)}), retrying…`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

/** Replace a metadata file (latest-mac.yml): delete the old asset, then upload. */
async function replaceAsset(releaseId, uploadUrl, assetName, data) {
  const assets = await gh(`/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`)
  for (const asset of assets) {
    if (asset.name === assetName) {
      await gh(`/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, { method: 'DELETE' })
      console.log(`publish-x64: deleted old ${assetName}`)
    }
  }
  await uploadAsset(uploadUrl, assetName, data)
}

/** Parse the subset of latest-mac.yml we care about (files + top-level fields). */
function parseUpdateInfo(text) {
  const info = { files: [] }
  let inFiles = false
  let current = null
  const flush = () => {
    if (current !== null) info.files.push(current)
    current = null
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'files:') {
      flush()
      inFiles = true
      continue
    }
    if (inFiles) {
      if (line.startsWith('- url:')) {
        flush()
        current = { url: line.slice(6).trim() }
      } else if (current !== null && line.startsWith('sha512:')) {
        current.sha512 = line.slice(7).trim()
      } else if (current !== null && line.startsWith('size:')) {
        current.size = Number(line.slice(5).trim())
      } else if (!line.startsWith('- ')) {
        flush()
        inFiles = false
      }
      if (inFiles) continue
    }
    if (line.startsWith('version:')) info.version = line.slice(8).trim()
    else if (line.startsWith('path:')) info.path = line.slice(5).trim()
    else if (line.startsWith('sha512:')) info.sha512 = line.slice(7).trim()
    else if (line.startsWith('releaseDate:')) info.releaseDate = line.slice(12).trim()
  }
  flush()
  return info
}

/** Minimal YAML emitter for the merged update info (kept dependency-free). */
function serializeUpdateInfo(info) {
  const lines = []
  if (info.version !== undefined) lines.push(`version: ${info.version}`)
  lines.push('files:')
  for (const f of info.files) {
    lines.push(`  - url: ${f.url}`)
    lines.push(`    sha512: ${f.sha512}`)
    lines.push(`    size: ${f.size}`)
  }
  if (info.path !== undefined) lines.push(`path: ${info.path}`)
  if (info.sha512 !== undefined) lines.push(`sha512: ${info.sha512}`)
  if (info.releaseDate !== undefined) lines.push(`releaseDate: ${info.releaseDate}`)
  return `${lines.join('\n')}\n`
}

/** Collect the arch's local artifacts from release/ and compute hashes. */
function loadLocalArtifacts(arch) {
  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    } catch {
      return null
    }
  })()
  if (version === null) fail('cannot read package.json version')

  const artifacts = []
  // Local single-arch electron-builder output: dmg is `dsh-desktop-<v>.dmg`,
  // mac zip is `dsh-desktop-<v>-mac.zip` (platform suffix). Upload both under
  // the arch-suffixed names (`-<arch>.dmg` / `-<arch>-mac.zip`).
  const candidates = [
    { local: `dsh-desktop-${version}.dmg`, remote: `dsh-desktop-${version}-${arch}.dmg` },
    { local: `dsh-desktop-${version}-mac.zip`, remote: `dsh-desktop-${version}-${arch}-mac.zip` },
  ]
  for (const { local, remote } of candidates) {
    const plain = join(RELEASE_DIR, local)
    if (exists(plain)) {
      artifacts.push({
        localPath: plain,
        remoteName: remote,
        info: artifactInfo(plain),
      })
    }
  }
  if (artifacts.length === 0) fail(`no artifacts in ${RELEASE_DIR} matching dsh-desktop-${version}.{zip,dmg} — run pnpm build first`)
  return { version, artifacts }
}

/** Append the arch's files to the update info; keep the first zip as the top-level path. */
function mergeUpdateInfo(existing, newFiles) {
  if (existing === null) {
    const first = newFiles[0]
    return { version: undefined, files: newFiles, path: first.url, sha512: first.sha512, releaseDate: new Date().toISOString() }
  }
  for (const file of newFiles) {
    if (!existing.files.some((f) => f.url === file.url)) existing.files.push(file)
  }
  return existing
}

async function downloadUpdateInfo(releaseId) {
  const assets = await gh(`/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`)
  const asset = assets.find((a) => a.name === 'latest-mac.yml')
  if (asset === undefined) return null
  // Use the assets API (not browser_download_url): the latter 404s for
  // DRAFT release assets (same draft limitation as /releases/tags).
  const response = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/octet-stream' },
  })
  if (!response.ok) throw new Error(`download latest-mac.yml failed: ${response.status}`)
  return parseUpdateInfo(await response.text())
}

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { tag: tagArg, arch } = parseArgs(process.argv.slice(2))
  if (TOKEN === undefined || TOKEN === '') fail('GH_TOKEN env var is required')

  // Tag resolution: explicit --tag wins; otherwise auto-detect the latest
  // `v*` tag (so a plain `pnpm run publish-x64` right after `pnpm run release`
  // targets the version that CI just built).
  const tag = tagArg ?? latestTag()
  if (tag === null) fail('no --tag given and no v* git tag found; pass --tag <vX.Y.Z>')

  const release = await getRelease(tag).catch((error) => fail(`release ${tag} not found: ${error.message}`))
  console.log(`publish-x64: release ${tag} (id ${release.id})`)

  const { version, artifacts } = loadLocalArtifacts(arch)
  console.log(`publish-x64: local ${arch} artifacts (version ${version}):`)
  for (const a of artifacts) console.log(`  ${a.localPath} -> ${a.remoteName} (${a.info.size} bytes)`)

  for (const artifact of artifacts) {
    await uploadAsset(release.uploadUrl, artifact.remoteName, readFileSync(artifact.localPath))
  }

  const existing = await downloadUpdateInfo(release.id)
  const merged = mergeUpdateInfo(existing, artifacts.map((a) => ({ url: a.remoteName, sha512: a.info.sha512, size: a.info.size })))
  const ymlText = serializeUpdateInfo(merged)
  await replaceAsset(release.id, release.uploadUrl, 'latest-mac.yml', Buffer.from(ymlText, 'utf8'))
  console.log('publish-x64: latest-mac.yml updated:')
  console.log(ymlText)

  await verifyRelease(release.id, tag, version)

  // Auto-publish: CI creates the release as a draft; once x64 is merged and
  // the release is complete, flip it to a public release so users can
  // download it. `--keep-draft` opts out.
  if (!process.argv.includes('--keep-draft')) {
    const releaseDetail = await gh(`/repos/${OWNER}/${REPO}/releases/${release.id}`)
    if (releaseDetail.draft) {
      await gh(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false }),
      })
      console.log(`publish-x64: ✅ published draft release ${tag} (now public)`)
    } else {
      console.log(`publish-x64: release ${tag} is already public (not a draft)`)
    }
  } else {
    console.log(`publish-x64: --keep-draft — leaving release ${tag} as draft`)
  }

  console.log('publish-x64: done')
}

void main().catch((error) => {
  console.error(`publish-x64: ${String(error.message ?? error)}`)
  process.exit(1)
})
// Explicit exit: some sockets (the draft-check request) may still be open
// when main resolves; letting the process drain them can surface a spurious
// EPIPE after all work is done.
process.on('exit', () => process.exit(0))
