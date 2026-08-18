/**
 * App update feeds: GitHub (default, mirrors electron-builder.yml publish
 * config / app-update.yml) plus the GitCode domestic mirror — a fixed `latest`
 * release managed by scripts/sync-domestic.mjs (see
 * docs/plans/国内发布与多更新源方案.md). P1 verified the GitCode feed serves
 * attachments anonymously over a CDN and electron-updater's generic provider
 * resolves `latest-*.yml` from the stable `releases/download/latest/` base.
 *
 * The feed list is baked in on purpose: adding a mirror is a code change plus
 * a sync-domestic target change, versioned together. Keep the GitCode
 * owner/repo in sync with .env (GITCODE_OWNER/GITCODE_REPO) and the GitHub
 * owner/repo with .env (GH_OWNER/GH_REPO), electron-builder.yml and
 * package.json's `repository`.
 * @module dsh-desktop/updateSources
 */

import type { UpdateSourceChoice } from './config.js'

export type UpdateSourceId = 'github' | 'gitcode'

export interface UpdateSource {
  id: UpdateSourceId
  name: string
  /** URL probed to decide reachability (used by 'auto' mode and the settings UI). */
  probeUrl: string
  /** Feed passed to autoUpdater.setFeedURL(). */
  feed:
    | { provider: 'github'; owner: string; repo: string }
    | { provider: 'generic'; url: string }
}

export interface ProbeResult {
  id: UpdateSourceId
  name: string
  reachable: boolean
  latencyMs: number | null
}

const PROBE_TIMEOUT_MS = 2500

export const UPDATE_SOURCES: UpdateSource[] = [
  {
    id: 'github',
    name: 'GitHub（默认源）',
    probeUrl: 'https://github.com',
    feed: { provider: 'github', owner: 'knight-peter', repo: 'deepseek-harness-desktop' },
  },
  {
    id: 'gitcode',
    name: 'GitCode 镜像（国内）',
    probeUrl: 'https://gitcode.com/xuqipeter/deepseek-harness-desktop/releases/download/latest/latest-mac.yml',
    feed: { provider: 'generic', url: 'https://gitcode.com/xuqipeter/deepseek-harness-desktop/releases/download/latest/' },
  },
]

export function sourceById(id: UpdateSourceId): UpdateSource | null {
  return UPDATE_SOURCES.find((s) => s.id === id) ?? null
}

/** Probe one feed: GET the probe URL with a short timeout; 2xx means reachable. */
export async function probeSource(source: UpdateSource): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const response = await fetch(source.probeUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return { id: source.id, name: source.name, reachable: response.ok, latencyMs: Date.now() - start }
  } catch {
    return { id: source.id, name: source.name, reachable: false, latencyMs: null }
  }
}

export function probeAllSources(): Promise<ProbeResult[]> {
  return Promise.all(UPDATE_SOURCES.map(probeSource))
}

/**
 * Resolve the feed for a stored choice. 'auto' probes the GitCode mirror
 * (primary for domestic users) and falls back to GitHub when unreachable; a
 * fixed choice always wins without probing.
 */
export async function resolveSource(choice: UpdateSourceChoice): Promise<UpdateSource> {
  if (choice === 'auto') {
    const gitcode = sourceById('gitcode')
    if (gitcode !== null && (await probeSource(gitcode)).reachable) return gitcode
  }
  return sourceById(choice === 'gitcode' ? 'gitcode' : 'github') ?? UPDATE_SOURCES[0]
}
