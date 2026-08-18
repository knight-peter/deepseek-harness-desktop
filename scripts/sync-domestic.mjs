/**
 * Sync release artifacts plus update metadata into the GitCode `latest`
 * release — the domestic update mirror (see docs/plans/国内发布与多更新源方案.md).
 *
 * Three data sources, one target:
 *   - default (local mode): the LOCAL release/ directory (single-arch
 *     electron-builder output, same as publish-x64.mjs) — syncs only the host
 *     mac architecture;
 *   - `--from-github`: the GitHub release for `--tag` (the single source of
 *     truth after CI + publish-x64 merged x64) — syncs the FULL multi-platform
 *     set (mac arm64+x64, windows, linux) and the three latest-*.yml files.
 *     NOTE: downloads from GitHub, so it needs GitHub-reachable network (a
 *     proxy or a GitHub-accelerated download worked around by --dir);
 *   - `--dir <path>`: upload whatever release artifacts are already present
 *     in a local directory (e.g. manually downloaded from the GitHub release
 *     page or a GitHub mirror), uploaded under their file names — the
 *     "download manually, upload automatically" path for the full mirror.
 *
 * Background (P1 verified): GitCode attachments upload via OBS presigned PUT
 * and download anonymously over a CDN; the download URL
 * `https://gitcode.com/<owner>/<repo>/releases/download/latest/<file>` is
 * stable, so electron-updater's generic provider can point at
 * `.../releases/download/latest/` forever while only the attachments change.
 *
 * Usage (pnpm forwards args directly, no `--` needed):
 *   pnpm run sync-domestic                          # local mode, auto version+arch
 *   pnpm run sync-domestic --arch arm64
 *   pnpm run sync-domestic --from-github            # full mirror from GitHub
 *   pnpm run sync-domestic --dir ./mirror           # upload pre-downloaded files
 *
 * Version source: the version is read from package.json's `version` field
 * (the single source of truth after `pnpm run release` — the `v<version>`
 * git tag matches it). No version argument is needed in the normal flow;
 * `--tag <vX.Y.Z>` only exists as an override for exceptional cases.
 * Requires:
 *   - GITCODE_TOKEN (add to .env.local), GITCODE_OWNER / GITCODE_REPO (in .env)
 *   - --from-github additionally: GH_TOKEN (.env.local), GH_OWNER / GH_REPO (.env)
 * The GitCode `latest` release must exist (created via the API or the web UI).
 * @module dsh-desktop/sync-domestic
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RELEASE_DIR = join(ROOT, 'release')

const API_GITCODE = 'https://api.gitcode.com/api/v5'
const API_GITHUB = 'https://api.github.com'
const TOKEN = process.env.GITCODE_TOKEN
const OWNER = process.env.GITCODE_OWNER
const REPO = process.env.GITCODE_REPO
const GH_TOKEN = process.env.GH_TOKEN
const GH_OWNER = process.env.GH_OWNER
const GH_REPO = process.env.GH_REPO
// Fixed-tag release that electron-updater's generic feed points at; stays
// constant across versions — only its attachments are replaced each release.
const TAG = 'latest'

if (OWNER === undefined || OWNER === '' || REPO === undefined || REPO === '') {
  fail('GITCODE_OWNER / GITCODE_REPO must be set (defined in .env; loaded via --env-file-if-exists)')
}

function fail(message) {
  console.error(`sync-domestic: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { tag: null, arch: process.arch === 'arm64' ? 'arm64' : 'x64', fromGithub: false, dir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = argv[++i] ?? null
    else if (argv[i] === '--arch') args.arch = argv[++i] ?? args.arch
    else if (argv[i] === '--from-github') args.fromGithub = true
    else if (argv[i] === '--dir') args.dir = argv[++i] ?? null
  }
  if (args.arch !== 'x64' && args.arch !== 'arm64') fail(`unsupported --arch ${args.arch} (x64|arm64)`)
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

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** sha512 (base64) + byte size of a buffer. */
function sha512Of(data) {
  return createHash('sha512').update(data).digest('base64')
}

// ── GitCode API ─────────────────────────────────────────────────────────────

async function gitcodeApi(path, options = {}) {
  const headers = { 'private-token': TOKEN, Accept: 'application/json', ...(options.headers ?? {}) }
  const response = await fetch(`${API_GITCODE}${path}`, { ...options, headers, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitCode API ${response.status} on ${path}: ${body.slice(0, 300)}`)
  }
  return response.status === 204 ? null : response.json()
}

/** Assets of the `latest` release that carry a real id (ours); the platform's
 * auto-generated source archives (zip/tar.gz/…) come back with id null and
 * cannot be deleted via the API — they are left alone. */
async function listManagedAssets() {
  const release = await gitcodeApi(`/repos/${OWNER}/${REPO}/releases/${TAG}`)
  return (release.assets ?? []).filter((a) => a.id !== null && a.id !== undefined)
}

async function deleteAsset(assetId) {
  await gitcodeApi(`/repos/${OWNER}/${REPO}/releases/${TAG}/attach_files/${assetId}`, { method: 'DELETE' })
}

/** Ask GitCode for an OBS presigned PUT URL for one attachment. */
async function getUploadUrl(fileName) {
  return gitcodeApi(`/repos/${OWNER}/${REPO}/releases/${TAG}/upload_url?file_name=${encodeURIComponent(fileName)}`)
}

/** PUT a buffer to the OBS presigned URL over HTTP/1.1 (the URL carries the
 * signature + x-obs-* headers from upload_url; expires in ~1h). A per-request
 * timeout keeps a hung connection (e.g. runner → OBS) from stalling forever. */
function obsPut(url, headers, data) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      url,
      { method: 'PUT', headers: { ...headers, 'Content-Length': data.length } },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolvePromise({ ok: res.statusCode === 200, status: res.statusCode ?? 0, body })
        })
      },
    )
    req.setTimeout(180_000, () => {
      req.destroy(new Error(`upload timeout after 180s (${url.slice(0, 120)})`))
    })
    req.on('error', reject)
    req.end(data)
  })
}

async function uploadFile(fileName, data) {
  const up = await getUploadUrl(fileName)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await obsPut(up.url, up.headers, data)
      if (result.ok) {
        console.log(`sync-domestic: uploaded ${fileName}`)
        return
      }
      throw new Error(`upload ${fileName} failed: ${result.status} ${result.body.slice(0, 300)}`)
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`sync-domestic: upload ${fileName} attempt ${attempt} failed (${String(error.message ?? error).slice(0, 120)}), retrying…`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000 * attempt))
    }
  }
}

// ── GitHub API (--from-github) ──────────────────────────────────────────────

async function githubApi(path) {
  const response = await fetch(`${API_GITHUB}${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-desktop-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub API ${response.status} on ${path}: ${body.slice(0, 300)}`)
  }
  return response.json()
}

/** HTTP/1.1 GET with redirect following and a per-hop timeout; Authorization
 * is dropped on redirect so the token never leaks to the CDN host. */
function httpGet(url, headers = {}, redirects = 0) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers }, (res) => {
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location !== undefined && redirects < 5) {
        res.resume()
        resolvePromise(httpGet(new URL(res.headers.location, url).toString(), {}, redirects + 1))
        return
      }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`timeout after 120s (${url.slice(0, 120)})`))
    })
    req.on('error', reject)
    req.end()
  })
}

async function downloadAsset(asset) {
  const url = `${API_GITHUB}/repos/${GH_OWNER}/${GH_REPO}/releases/assets/${asset.id}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    console.log(`sync-domestic: downloading ${asset.name} (attempt ${attempt})…`)
    try {
      const res = await httpGet(url, {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/octet-stream',
        'User-Agent': 'dsh-desktop-sync',
      })
      if (res.status !== 200) throw new Error(`download ${asset.name} failed: HTTP ${res.status}`)
      console.log(`sync-domestic: downloaded ${asset.name} (${res.body.length} bytes in ${((Date.now() - started) / 1000).toFixed(0)}s)`)
      return res.body
    } catch (error) {
      if (attempt === 3) throw error
      console.warn(`sync-domestic: download ${asset.name} attempt ${attempt} failed (${String(error.message ?? error).slice(0, 120)}), retrying…`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000 * attempt))
    }
  }
}

/** Pull the full multi-platform artifact set + latest-*.yml from the GitHub
 * release for `tag`, downloading into release/.sync-cache. */
async function loadGithubArtifacts(tag) {
  const release = await githubApi(`/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${encodeURIComponent(tag)}`)
  const version = tag.replace(/^v/, '')
  const keep = (name) => /\.(dmg|zip|exe|AppImage)$/.test(name) || /^latest(-mac|-linux)?\.yml$/.test(name)
  const wanted = (release.assets ?? []).filter((a) => keep(a.name))
  if (wanted.length === 0) fail(`no syncable assets on GitHub release ${tag}`)

  const cacheDir = join(RELEASE_DIR, '.sync-cache')
  mkdirSync(cacheDir, { recursive: true })
  const artifacts = []
  const ymls = new Map()
  for (const asset of wanted) {
    const data = await downloadAsset(asset)
    if (/^latest.*\.yml$/.test(asset.name)) {
      ymls.set(asset.name, data.toString('utf8'))
      console.log(`sync-domestic: fetched ${asset.name} (${data.length} bytes)`)
    } else {
      const localPath = join(cacheDir, asset.name)
      writeFileSync(localPath, data)
      artifacts.push({ localPath, remoteName: asset.name, info: { sha512: sha512Of(data), size: data.length } })
      console.log(`sync-domestic: fetched ${asset.name} (${data.length} bytes)`)
    }
  }
  return { version, artifacts, ymls }
}

/** Verify downloaded artifacts against the sha512 recorded in latest-*.yml. */
function verifyArtifactShas(artifacts, ymls) {
  for (const text of ymls.values()) {
    const files = parseUpdateInfo(text).files
    for (const file of files) {
      const artifact = artifacts.find((a) => a.remoteName === file.url)
      if (artifact === undefined) continue
      if (artifact.info.sha512 !== file.sha512) {
        fail(`sha512 mismatch for ${file.url} (GitHub yml ${file.sha512} vs downloaded ${artifact.info.sha512})`)
      }
      console.log(`sync-domestic:   ✓ sha512 ${file.url}`)
    }
  }
}

// ── local mode helpers ──────────────────────────────────────────────────────

/** Collect release artifacts already present in a directory (manual download
 * from the GitHub release page or a mirror), uploaded under their own names. */
function loadDirArtifacts(dir) {
  const keep = (name) => /\.(dmg|zip|exe|AppImage)$/.test(name) || /^latest(-mac|-linux)?\.yml$/.test(name)
  const artifacts = []
  const ymls = new Map()
  for (const name of readdirSync(dir)) {
    if (!keep(name)) continue
    const data = readFileSync(join(dir, name))
    if (/^latest.*\.yml$/.test(name)) {
      ymls.set(name, data.toString('utf8'))
    } else {
      artifacts.push({ localPath: join(dir, name), remoteName: name, info: { sha512: sha512Of(data), size: data.length } })
    }
  }
  if (artifacts.length === 0) fail(`no syncable artifacts in ${dir} (expected *.dmg/*.zip/*.exe/*.AppImage + latest-*.yml)`)
  return { artifacts, ymls }
}

/** Collect the arch's local mac artifacts and rename them with the arch
 * suffix electron-updater matches on (`-<arch>.dmg` / `-<arch>-mac.zip`). */
function loadLocalArtifacts(arch) {
  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    } catch {
      return null
    }
  })()
  if (version === null) fail('cannot read package.json version')

  const candidates = [
    { local: `dsh-desktop-${version}.dmg`, remote: `dsh-desktop-${version}-${arch}.dmg` },
    { local: `dsh-desktop-${version}-mac.zip`, remote: `dsh-desktop-${version}-${arch}-mac.zip` },
  ]
  const artifacts = []
  for (const { local, remote } of candidates) {
    const plain = join(RELEASE_DIR, local)
    if (exists(plain)) {
      artifacts.push({ localPath: plain, remoteName: remote, info: { sha512: sha512Of(readFileSync(plain)), size: statSync(plain).size } })
    }
  }
  if (artifacts.length === 0) fail(`no artifacts in ${RELEASE_DIR} matching dsh-desktop-${version}.{dmg,-mac.zip} — run pnpm build first`)
  return { version, artifacts }
}

/** Rewrite the locally-generated latest-mac.yml so files[].url / path point at
 * the arch-suffixed remote names (sha512/size are unchanged — same bytes). */
function rewriteUpdateInfo(version, arch) {
  const metadataPath = join(RELEASE_DIR, 'latest-mac.yml')
  if (!exists(metadataPath)) fail('release/latest-mac.yml not found — run pnpm build first')
  let text = readFileSync(metadataPath, 'utf8')
  const localZip = `dsh-desktop-${version}-mac.zip`
  const remoteZip = `dsh-desktop-${version}-${arch}-mac.zip`
  const localDmg = `dsh-desktop-${version}.dmg`
  const remoteDmg = `dsh-desktop-${version}-${arch}.dmg`
  if (!text.includes(localZip)) fail(`latest-mac.yml does not reference ${localZip} — unexpected metadata`)
  // dmg entry is optional (some electron-builder versions only list the zip);
  // replacing a missing string is a no-op.
  return text.split(localZip).join(remoteZip).split(localDmg).join(remoteDmg)
}

/** Minimal parser for the fields of latest-*.yml we care about (files only). */
function parseUpdateInfo(text) {
  const files = []
  let inFiles = false
  let current = null
  const flush = () => {
    if (current !== null) files.push(current)
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
  }
  flush()
  return { files }
}

// ── shared upload + verify ──────────────────────────────────────────────────

async function uploadAll(artifacts, ymls) {
  const existing = await listManagedAssets()
  for (const asset of existing) {
    await deleteAsset(asset.id)
    console.log(`sync-domestic: deleted old ${asset.name}`)
  }
  for (const a of artifacts) {
    await uploadFile(a.remoteName, readFileSync(a.localPath))
  }
  for (const [name, content] of ymls) {
    await uploadFile(name, Buffer.from(content, 'utf8'))
  }
}

/** Verify every expected attachment is present and that each channel file is
 * reachable and byte-identical through the public download URL (end-to-end). */
async function verifySync(expectedFiles, ymls) {
  const release = await gitcodeApi(`/repos/${OWNER}/${REPO}/releases/${TAG}`)
  const names = (release.assets ?? []).map((a) => a.name)
  const missing = expectedFiles.filter((n) => !names.includes(n))
  for (const n of expectedFiles) {
    console.log(`sync-domestic:   ${names.includes(n) ? '✓' : '✗'} ${n}`)
  }
  if (missing.length > 0) fail(`attachments missing on GitCode: ${missing.join(', ')}`)

  for (const [name, content] of ymls) {
    const url = `https://gitcode.com/${OWNER}/${REPO}/releases/download/${TAG}/${name}`
    const response = await fetch(url)
    if (!response.ok) fail(`download check failed: ${response.status} on ${url}`)
    const downloaded = await response.text()
    if (downloaded !== content) fail(`downloaded ${name} does not match what was uploaded`)
    console.log(`sync-domestic: ✅ ${name} reachable & identical via ${url}`)
  }
}

async function main() {
  const { tag: tagArg, arch, fromGithub, dir } = parseArgs(process.argv.slice(2))
  if (TOKEN === undefined || TOKEN === '') fail('GITCODE_TOKEN env var is required (add to .env.local)')
  if (fromGithub && (GH_TOKEN === undefined || GH_TOKEN === '' || GH_OWNER === undefined || GH_REPO === undefined)) {
    fail('--from-github requires GH_TOKEN (.env.local) and GH_OWNER/GH_REPO (.env)')
  }

  const tag = tagArg ?? packageTag()
  if (tag === null) fail('cannot read version from package.json; pass --tag <vX.Y.Z> to override')
  const version = tag.replace(/^v/, '')

  let artifacts
  let ymls
  let mode
  if (dir !== null) {
    console.log(`sync-domestic: loading pre-downloaded artifacts from ${dir}`)
    const loaded = loadDirArtifacts(dir)
    artifacts = loaded.artifacts
    ymls = loaded.ymls
    verifyArtifactShas(artifacts, ymls)
    mode = 'dir'
  } else if (fromGithub) {
    console.log(`sync-domestic: pulling ${tag} from GitHub (${GH_OWNER}/${GH_REPO})`)
    const loaded = await loadGithubArtifacts(tag)
    artifacts = loaded.artifacts
    ymls = loaded.ymls
    verifyArtifactShas(artifacts, ymls)
    mode = 'github'
  } else {
    const local = loadLocalArtifacts(arch)
    artifacts = local.artifacts
    ymls = new Map([['latest-mac.yml', rewriteUpdateInfo(local.version, arch)]])
    mode = `local ${arch}`
  }

  console.log(`sync-domestic: syncing v${version} → ${OWNER}/${REPO} release "${TAG}" (${mode})`)
  for (const a of artifacts) {
    console.log(`  ${a.localPath} -> ${a.remoteName} (${a.info.size} bytes)`)
  }

  await uploadAll(artifacts, ymls)
  console.log('sync-domestic: metadata:')
  for (const [name, content] of ymls) console.log(`  --- ${name} ---\n${content}`)

  await verifySync([...artifacts.map((a) => a.remoteName), ...ymls.keys()], ymls)
  console.log('sync-domestic: done')
}

void main().catch((error) => {
  console.error(`sync-domestic: ${String(error.message ?? error)}`)
  process.exit(1)
})
