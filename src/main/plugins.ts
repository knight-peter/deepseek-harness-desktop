/**
 * Plugin management backend (Phase 3 + M1/M2): wraps the upstream `dsh plugin
 * --profile web <pnpm args>` machinery (pnpm install + bundles reconcile),
 * reads the profile manifest for the installed bundle list, and reports
 * results for the manager UI. Electron-free: paths and the node executable
 * are injected by the caller.
 *
 * M1: commands run streaming (live output for the UI) and their outcome is
 * triaged into typed issues — pnpm ≥10/11 build-script approval (node-pty and
 * friends), git-hosted prepare scripts, missing pnpm, registry/network
 * failures. `approveBuilds()` writes the canonical `allowBuilds` map into the
 * profile's `pnpm-workspace.yaml` and re-runs `pnpm install` so the approved
 * scripts actually run — the desktop equivalent of the official
 * `cd $DSH_HOME/profiles/web && pnpm approve-builds --all` dance.
 * M2: install results diff the profile manifest and classify what was added
 * (bundle layer / client plugin / plain dependency) so the UI can say whether
 * the new package is actually going to be mounted.
 * @module dsh-desktop/plugins
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** The shipped web-profile bundle tuple; never user-managed. */
export const TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Hard cap for one plugin/pnpm command run; matches the old spawnSync timeout. */
const COMMAND_TIMEOUT_MS = 300_000

/** npm registry metadata fetch timeout. */
const REGISTRY_TIMEOUT_MS = 8_000

export interface InstalledPlugin {
  name: string
  version: string
  /** Effective layer membership: listed under `dsh.profile.bundles`. */
  bundle: boolean
  /** Installed package declares `dsh.client` (ships a web-UI half). */
  client: boolean
  /** Part of the shipped web template, not a user dependency. */
  template: boolean
  /** The dependency spec in the manifest (`^1.0.0`, `file:…`, `git+…`). */
  spec?: string
}

export interface PluginManagerOptions {
  /** `$DSH_HOME/profiles/web`. */
  profileDir: string
  /** Absolute path to the dsh CLI entry (`lib/bin.js`). */
  dshBin: string
  /** Node executable used to run the dsh CLI (Electron binary as node in release). */
  nodeCommand: string
  /** Extra Node CLI args before the script (e.g. `--require` preload). */
  nodeArgs?: string[]
  /** Extra environment, e.g. PATH with pnpm; `ELECTRON_RUN_AS_NODE` included by caller. */
  env: Record<string, string>
  /** `$DSH_HOME/plugins-local`: local plugin sources (`scaffold` writes here). */
  pluginsLocalDir: string
}

export interface CommandResult {
  ok: boolean
  exitCode: number | null
  output: string
}

/** Live output of a streaming command run. */
export type ProgressChunk = { chunk: string; stream: 'stdout' | 'stderr' }
export type ProgressFn = (chunk: ProgressChunk) => void

/** Typed failure/attention reasons the manager UI can act on. */
export type PluginIssueKind =
  | 'build-approval' // pnpm ≥10 ignored/blocked dependency build scripts (e.g. node-pty)
  | 'git-prepare' // git-hosted plugin prepare script blocked by pnpm
  | 'pnpm-missing'
  | 'registry'
  | 'network'
  | 'none'

export interface PluginIssue {
  kind: PluginIssueKind
  /** Package names pnpm wants allowed to run build scripts (when parseable). */
  packages?: string[]
  hint?: string
}

/** Manifest snapshot used to diff an install. */
export interface ProfileSnapshot {
  dependencies: Record<string, string>
  bundles: string[]
}

export interface AddedPluginInfo {
  name: string
  version: string
  /** Declares `dsh.bundle.patch` (a profile patch layer). */
  bundle: boolean
  /** Declares `dsh.client` (ships a web-UI half). */
  client: boolean
}

export interface InstallSummary {
  delta: {
    added: string[]
    removed: string[]
    bundlesAdded: string[]
    bundlesRemoved: string[]
  }
  added: AddedPluginInfo[]
  /** Human-readable notes: plain deps that will not mount, skipped build scripts. */
  warnings: string[]
}

/** Install result: command status + typed issue + post-install summary. */
export interface PluginMutationResult extends CommandResult {
  /** Non-null when the command failed for a reason the UI can remediate. */
  issue: PluginIssue | null
  /** Non-empty when the install succeeded but dependency build scripts were skipped. */
  warningPackages: string[]
  summary: InstallSummary | null
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/**
 * Compare two semver-ish versions (`x.y.z` with optional `-prerelease`).
 * Returns <0 / 0 / >0 like a comparator. Release > same-base prerelease;
 * prerelease identifiers compare numerically when both are numeric, else
 * lexically. Unparseable strings fall back to lexicographic order.
 * Used wherever「有可更新版本」= 最新版 > 已装版, never mere inequality.
 */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a.trim())
  const mb = SEMVER_RE.exec(b.trim())
  if (ma === null || mb === null) {
    return a === b ? 0 : a < b ? -1 : 1
  }
  for (let i = 1; i <= 3; i++) {
    const x = Number(ma[i])
    const y = Number(mb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  const preA = ma[4]
  const preB = mb[4]
  if (preA === undefined && preB === undefined) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      const nx = Number(x)
      const ny = Number(y)
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (numericX !== numericY) return numericX ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Package names listed in an "Ignored build scripts: …" pnpm line. */
function parseIgnoredPackages(output: string): string[] {
  const names = new Set<string>()
  const re = /Ignored build scripts:\s*([^\n]+)/gi
  for (const match of output.matchAll(re)) {
    let text = match[1] ?? ''
    const cut = text.search(/\.?\s*(?:Run "pnpm|$)/)
    if (cut >= 0) text = text.slice(0, cut)
    for (const raw of text.split(',')) {
      const name = raw.trim().replace(/\.$/, '')
      // Accept plain (`node-pty`) and scoped (`@scope/pkg`) package names only.
      if (name !== '' && /^@?[A-Za-z0-9][A-Za-z0-9@._/-]{0,200}$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

function isGitSpec(spec: string): boolean {
  return /^git\+|^github:|\.git(?:#|$)/.test(spec)
}

/**
 * Triage a `dsh plugin`/pnpm run into a typed issue the manager UI can
 * remediate (or explain). Runs after a command completes.
 * - `issue`: the command failed (or a hard block) and this is the reason.
 * - `warning`: the command succeeded but dependency build scripts were skipped
 *   (pnpm 10 non-strict default) — worth an attention banner.
 */
export function analyzePluginOutput(result: CommandResult, spec?: string): { issue: PluginIssue | null; warning: PluginIssue | null } {
  const output = result.output
  const ignored = parseIgnoredPackages(output)

  if (!result.ok && result.exitCode !== 0 && /pnpm not found on PATH|not found on PATH \(ENOENT\)/i.test(output)) {
    return {
      issue: { kind: 'pnpm-missing', hint: 'PATH 上找不到 pnpm。发布版由应用内置垫片提供；开发版需在启动 shell 里装好 pnpm。' },
      warning: null,
    }
  }
  if (/git-hosted plugins build on install via their prepare script/i.test(output)
    || (spec !== undefined && isGitSpec(spec) && /prepare script/i.test(output) && /allowBuilds/i.test(output))) {
    return {
      issue: {
        kind: 'git-prepare',
        packages: ignored.length > 0 ? ignored : undefined,
        hint: 'pnpm 拦截了 git 插件的 prepare 构建脚本：需把脚本所属包加入 profile pnpm-workspace.yaml 的 allowBuilds 后重装。',
      },
      warning: null,
    }
  }
  if (ignored.length > 0) {
    if (result.ok) {
      return {
        issue: null,
        warning: {
          kind: 'build-approval',
          packages: ignored,
          hint: '安装成功，但以下依赖的构建脚本未执行；如需编译原生模块请放行后重建：',
        },
      }
    }
    return {
      issue: {
        kind: 'build-approval',
        packages: ignored,
        hint: 'pnpm 拦截了以下依赖的构建脚本：放行并重装即可（等同官方 `pnpm approve-builds --all` 流程）。',
      },
      warning: null,
    }
  }
  if (!result.ok) {
    if (/404|E404|ETARGET|No matching version found for/i.test(output)) {
      return { issue: { kind: 'registry', hint: '包名或版本在 npm registry 上不存在（404 / 版本不匹配）。' }, warning: null }
    }
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|network error/i.test(output)) {
      return { issue: { kind: 'network', hint: '网络错误：registry 不可达或代理问题，请检查网络后重试。' }, warning: null }
    }
    return { issue: { kind: 'none', hint: undefined }, warning: null }
  }
  return { issue: null, warning: null }
}

export class PluginManager {
  constructor(private readonly options: PluginManagerOptions) {}

  // ── streaming command runners ─────────────────────────────────────────────

  /** `dsh plugin --profile web <args...>` via the injected node + env, streaming. */
  private async runPluginCommand(args: string[], onProgress?: ProgressFn): Promise<CommandResult> {
    if (this.options.dshBin === '') {
      return { ok: false, exitCode: null, output: '未找到 dsh 引擎：无法执行插件管理命令（请先配置引擎来源）' }
    }
    const argv = ['--expose-internals', ...(this.options.nodeArgs ?? []), this.options.dshBin, 'plugin', '--profile', 'web', ...args]
    return this.runProcess(this.options.nodeCommand, argv, undefined, onProgress)
  }

  /** Direct `pnpm <args>` in the profile directory (approve/install steps). */
  private async runPnpm(args: string[], onProgress?: ProgressFn): Promise<CommandResult> {
    const result = await this.runProcess('pnpm', args, this.options.profileDir, onProgress)
    if (!result.ok && result.exitCode === null) {
      // spawn-level failure (e.g. pnpm ENOENT): report like the engine does.
      return {
        ok: false,
        exitCode: 127,
        output: /not found on PATH/i.test(result.output)
          ? 'pnpm not found on PATH — 发布版由应用内置垫片提供；开发版请先安装 pnpm'
          : result.output,
      }
    }
    return result
  }

  /**
   * Spawn one child, collect stdout+stderr, stream raw chunks, and settle
   * with a CommandResult. A spawn failure (ENOENT, …) becomes a non-zero
   * result instead of a throw, so callers always handle a CommandResult.
   */
  private runProcess(
    command: string,
    args: string[],
    cwd: string | undefined,
    onProgress?: ProgressFn,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      let child: ReturnType<typeof spawn> | undefined
      // `settle` reads `timer`, which is initialized right below; every
      // invocation happens after this executor body has run to completion.
      const timer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // ignore
        }
        output += `\n[${command} 超过 ${COMMAND_TIMEOUT_MS / 1000}s 被终止]`
        settle(false, null, output)
      }, COMMAND_TIMEOUT_MS)
      function settle(ok: boolean, exitCode: number | null, text: string): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok, exitCode, output: text })
      }
      try {
        child = spawn(command, args, {
          cwd,
          env: this.options.env,
          shell: process.platform === 'win32',
          windowsHide: true,
        })
      } catch (error) {
        settle(false, null, `spawn ${command} failed: ${String(error)}`)
        return
      }
      const stdout = child.stdout
      const stderr = child.stderr
      stdout?.setEncoding('utf8')
      stderr?.setEncoding('utf8')
      stdout?.on('data', (chunk: string) => {
        output += chunk
        if (onProgress !== undefined) onProgress({ chunk, stream: 'stdout' })
      })
      stderr?.on('data', (chunk: string) => {
        output += chunk
        if (onProgress !== undefined) onProgress({ chunk, stream: 'stderr' })
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        const detail = error.code === 'ENOENT' ? `${command} not found on PATH (ENOENT)` : String(error)
        settle(false, null, `${output}\n${detail}`.trim())
      })
      child.on('close', (code) => {
        settle(code === 0, code, output)
      })
    })
  }

  // ── profile manifest reads ────────────────────────────────────────────────

  /** Profile manifest snapshot (`dependencies` + `dsh.profile.bundles`). */
  snapshot(): ProfileSnapshot {
    const manifest = readJson(join(this.options.profileDir, 'package.json'))
    if (manifest === null) return { dependencies: {}, bundles: [] }
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
    const profile = (manifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile
    const bundles = (profile?.bundles ?? []) as string[]
    return { dependencies, bundles }
  }

  /** The installed package's declared `dsh` role fields (bundle/client). */
  private declaredKind(name: string): { bundle: boolean; client: boolean } {
    const dsh = this.readInstalledManifest(name)?.dsh as { bundle?: { patch?: unknown }; client?: unknown } | undefined
    return {
      bundle: dsh?.bundle?.patch !== undefined,
      client: Boolean(dsh?.client),
    }
  }

  /** Installed plugins from the profile manifest (dependencies + bundle layers). */
  list(): InstalledPlugin[] {
    const { dependencies, bundles } = this.snapshot()
    const plugins: InstalledPlugin[] = []
    for (const [name, spec] of Object.entries(dependencies)) {
      const manifest = this.readInstalledManifest(name)
      const dsh = manifest?.dsh as { client?: unknown } | undefined
      plugins.push({
        name,
        version: manifest?.version !== undefined ? String(manifest.version) : String(spec),
        bundle: bundles.includes(name),
        client: Boolean(dsh?.client),
        template: false,
        spec,
      })
    }
    for (const name of TEMPLATE_BUNDLES) {
      plugins.push({
        name,
        version: this.installedVersion(name) ?? 'template',
        bundle: true,
        client: false,
        template: true,
      })
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Version from the installed package tree (profile-local, then the shared farm). */
  installedVersion(name: string): string | null {
    const manifest = this.readInstalledManifest(name)
    return manifest?.version !== undefined ? String(manifest.version) : null
  }

  private readInstalledManifest(name: string): Record<string, unknown> | null {
    for (const dir of [this.options.profileDir, join(this.options.profileDir, '..')]) {
      const manifest = readJson(join(dir, 'node_modules', name, 'package.json'))
      if (manifest !== null) return manifest
    }
    return null
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  /** `dsh plugin add <spec>`, then a manifest diff summary + issue triage. */
  async install(spec: string, onProgress?: ProgressFn): Promise<PluginMutationResult> {
    const before = this.snapshot()
    const result = await this.runPluginCommand(['add', spec], onProgress)
    if (!result.ok) {
      const { issue } = analyzePluginOutput(result, spec)
      return { ...result, issue, warningPackages: [], summary: null }
    }
    const after = this.snapshot()
    const { warning } = analyzePluginOutput(result, spec)
    const summary = this.summarizeInstall(before, after)
    const warningPackages = warning?.kind === 'build-approval' ? warning.packages ?? [] : []
    if (warningPackages.length > 0) {
      summary.warnings.push(`以下依赖的构建脚本未执行：${warningPackages.join(', ')}。如需编译原生模块，可在界面点“放行并重装”。`)
    }
    return { ...result, issue: null, warningPackages, summary }
  }

  /** `dsh plugin remove <name>`. */
  async uninstall(name: string, onProgress?: ProgressFn): Promise<CommandResult> {
    return this.runPluginCommand(['remove', name], onProgress)
  }

  /** `dsh plugin update [name]` — no name updates every profile dependency. */
  async update(target: string | undefined, onProgress?: ProgressFn): Promise<CommandResult> {
    return this.runPluginCommand(target === undefined ? ['update'] : ['update', target], onProgress)
  }

  /**
   * Desktop equivalent of `cd $DSH_HOME/profiles/web && pnpm approve-builds
   * --all`: merge `allowBuilds: { <pkg>: true }` entries into the profile's
   * `pnpm-workspace.yaml`, then run `pnpm install` so the approved build
   * scripts actually execute. The caller re-runs the original `add`
   * afterwards (that performs the bundles reconcile).
   */
  async approveBuilds(packages: string[], onProgress?: ProgressFn): Promise<CommandResult> {
    if (!this.profileExists) {
      return { ok: false, exitCode: null, output: 'profile 尚未初始化：无法写入 pnpm-workspace.yaml' }
    }
    if (packages.length === 0) {
      return { ok: false, exitCode: null, output: '没有可放行的包名' }
    }
    const writeResult = this.writeAllowBuilds(packages)
    if (!writeResult.ok) return writeResult
    return this.runPnpm(['install'], onProgress)
  }

  /** Merge `allowBuilds: { <pkg>: true }` entries into the profile workspace YAML. */
  private writeAllowBuilds(packages: string[]): CommandResult {
    const file = join(this.options.profileDir, 'pnpm-workspace.yaml')
    let doc: Record<string, unknown>
    try {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const parsed: unknown = text.trim() === '' ? {} : yaml.load(text)
      doc = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch (error) {
      return { ok: false, exitCode: null, output: `读取 ${file} 失败：${String(error)}` }
    }
    const allow = (doc.allowBuilds ?? {}) as Record<string, unknown>
    if (allow === null || typeof allow !== 'object' || Array.isArray(allow)) {
      return { ok: false, exitCode: null, output: `${file} 的 allowBuilds 不是键值映射，请手动检查` }
    }
    for (const pkg of packages) allow[pkg] = true
    doc.allowBuilds = allow
    try {
      writeFileSync(file, `${yaml.dump(doc, { indent: 2, lineWidth: 120, noRefs: true })}`)
    } catch (error) {
      return { ok: false, exitCode: null, output: `写入 ${file} 失败：${String(error)}` }
    }
    return { ok: true, exitCode: 0, output: `已放行构建脚本：${packages.join(', ')}（${file}）\n` }
  }

  /** Diff an install's before/after manifest and classify each added package. */
  private summarizeInstall(before: ProfileSnapshot, after: ProfileSnapshot): InstallSummary {
    const delta = {
      added: Object.keys(after.dependencies).filter((name) => !(name in before.dependencies)),
      removed: Object.keys(before.dependencies).filter((name) => !(name in after.dependencies)),
      bundlesAdded: after.bundles.filter((name) => !before.bundles.includes(name)),
      bundlesRemoved: before.bundles.filter((name) => !after.bundles.includes(name)),
    }
    const added: AddedPluginInfo[] = delta.added.map((name) => ({
      name,
      version: this.installedVersion(name) ?? String(after.dependencies[name]),
      ...this.declaredKind(name),
    }))
    const warnings: string[] = []
    for (const info of added) {
      if (!info.bundle && !info.client) {
        warnings.push(`${info.name}@${info.version} 未声明 dsh.bundle —— 只是普通依赖，不会挂载为插件层`)
      }
    }
    return { delta, added, warnings }
  }

  /**
   * `@scope/name` → latest version from the npm registry (`dist-tags.latest`),
   * or null when offline / unknown. Used for stale-row detection.
   */
  async registryLatest(name: string): Promise<string | null> {
    const encoded = name.split('/').map(encodeURIComponent).join('%2F')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS)
    try {
      const response = await fetch(`https://registry.npmjs.org/${encoded}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return null
      const json = (await response.json()) as { 'dist-tags'?: { latest?: unknown } }
      const latest = json['dist-tags']?.latest
      return typeof latest === 'string' ? latest : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // ── scaffolding ───────────────────────────────────────────────────────────

  /**
   * Scaffold a new local bundle plugin under `$DSH_HOME/plugins-local/<name>`
   * (package.json with `dsh.bundle`, a function-plugin entry, and its patch
   * layer). The caller then installs it via `file:<dir>`.
   * @param name - lowercase npm-style plugin name.
   */
  scaffold(name: string): { ok: boolean; dir?: string; error?: string } {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return { ok: false, error: '插件名只能由小写字母、数字、连字符组成' }
    }
    const dir = join(this.options.pluginsLocalDir, name)
    if (existsSync(dir)) return { ok: false, error: `目录已存在：${dir}` }
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name,
      version: '0.0.1',
      description: `Local bundle plugin scaffolded by dsh-desktop`,
      private: true,
      type: 'module',
      exports: { './entry': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'lib', 'index.js'), `// ${name}: a host-side function plugin mounted by the patch layer below.
export const name = '${name}'

export const inject = []

export function apply(ctx) {
  console.log('[${name}] mounted')
  ctx.provide('${name}Greeting', 'hello from ${name}')
}
`)
    writeFileSync(join(dir, 'cordis.patch.yml'), `# ${name} patch layer: mounts the entry as one web-profile row.
- insert:
    - id: ${name}
      name: ${name}/entry
`)
    return { ok: true, dir }
  }

  /** Profile patch file (`$DSH_HOME/profiles/web/cordis.patch.yml`). */
  get patchPath(): string {
    return join(this.options.profileDir, 'cordis.patch.yml')
  }

  get profileExists(): boolean {
    return existsSync(join(this.options.profileDir, 'package.json'))
  }
}
