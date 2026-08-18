/**
 * Plugin management backend (Phase 3): wraps the upstream `dsh plugin
 * --profile web <pnpm args>` machinery (pnpm install + bundles reconcile),
 * reads the profile manifest for the installed bundle list, and reports
 * results for the manager UI. Electron-free: paths and the node executable
 * are injected by the caller.
 * @module dsh-desktop/plugins
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The shipped web-profile bundle tuple; never user-managed. */
export const TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export interface InstalledPlugin {
  name: string
  version: string
  /** Declares `dsh.bundle` — a profile layer (user-managed bundle). */
  bundle: boolean
  /** Part of the shipped web template, not a user dependency. */
  template: boolean
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

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export class PluginManager {
  constructor(private readonly options: PluginManagerOptions) {}

  /** `dsh plugin --profile web <args...>` via the injected node + env. */
  runPluginCommand(args: string[]): CommandResult {
    if (this.options.dshBin === '') {
      return { ok: false, exitCode: null, output: '未找到 dsh 引擎：无法执行插件管理命令（请先配置引擎来源）' }
    }
    const result = spawnSync(this.options.nodeCommand, ['--expose-internals', ...(this.options.nodeArgs ?? []), this.options.dshBin, 'plugin', '--profile', 'web', ...args], {
      env: this.options.env,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    return { ok: result.status === 0, exitCode: result.status, output }
  }

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

  /** Installed plugins from the profile manifest (dependencies + bundle layers). */
  list(): InstalledPlugin[] {
    const dir = this.options.profileDir
    const manifest = readJson(join(dir, 'package.json'))
    if (manifest === null) return []
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
    const dshField = manifest.dsh as { profile?: { bundles?: unknown } } | undefined
    const bundles = (dshField?.profile?.bundles ?? []) as string[]
    const plugins: InstalledPlugin[] = []
    for (const name of Object.keys(dependencies)) {
      plugins.push({
        name,
        version: this.installedVersion(name) ?? String(dependencies[name]),
        bundle: bundles.includes(name),
        template: false,
      })
    }
    for (const name of TEMPLATE_BUNDLES) {
      plugins.push({ name, version: this.installedVersion(name) ?? 'template', bundle: true, template: true })
    }
    return plugins.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Version from the installed package tree (profile-local, then the shared farm). */
  private installedVersion(name: string): string | null {
    for (const dir of [this.options.profileDir, join(this.options.profileDir, '..')]) {
      const manifest = readJson(join(dir, 'node_modules', name, 'package.json'))
      if (manifest?.version !== undefined) return String(manifest.version)
    }
    return null
  }

  install(spec: string): CommandResult {
    return this.runPluginCommand(['add', spec])
  }

  uninstall(name: string): CommandResult {
    return this.runPluginCommand(['remove', name])
  }

  update(name?: string): CommandResult {
    return this.runPluginCommand(name === undefined ? ['update'] : ['update', name])
  }

  /** Profile patch file (`$DSH_HOME/profiles/web/cordis.patch.yml`). */
  get patchPath(): string {
    return join(this.options.profileDir, 'cordis.patch.yml')
  }

  get profileExists(): boolean {
    return existsSync(join(this.options.profileDir, 'package.json'))
  }
}
