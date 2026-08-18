/**
 * dsh-desktop main process: single-instance lock, main window (status shell
 * → engine UI), manager window (plugins / debug / settings), menu, IPC, and
 * engine lifecycle. The engine runs as a child process under Electron's
 * embedded Node (`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`).
 * @module dsh-desktop/main
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { Harness, nodeSatisfiesEngine } from './harness.js'
import { allowClipboardPermissions, ClipboardWatcher, pasteTextToFocusedWindow } from './clipboard.js'
import type { Settings, UpdateSourceChoice } from './config.js'
import { SettingsStore } from './config.js'
import { PluginManager } from './plugins.js'
import { diagnoseStartupFailure, Tools } from './tools.js'
import { backupDshHome, installedEngineVersion, latestEngineVersion } from './updater.js'
import { probeAllSources, resolveSource, sourceById } from './updateSources.js'

// electron-updater is CommonJS; named ESM imports fail at load time.
const require = createRequire(import.meta.url)
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')

let mainWindow: BrowserWindow | null = null
let managerWindow: BrowserWindow | null = null
let engineUiLoaded = false
let lastDump = ''
let quitting = false
/** True while a check was triggered from the menu (needs a visible result). */
let manualUpdateCheck = false

const settings = new SettingsStore(app.getPath('userData'))

// Clipboard change watcher: broadcasts plain-text clipboard changes to every
// window (see preload's `onClipboardChange`). Started once the app is ready.
const clipboardWatcher = new ClipboardWatcher({
  onTextChange: (text) => broadcast('clipboard:change', text),
})

function dshHome(): string {
  return process.env.DSH_HOME ?? join(app.getPath('home'), '.dsh')
}

function profileDir(): string {
  return join(dshHome(), 'profiles', 'web')
}

function engineDir(): string {
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(resources, 'engine')
}

/** Engine child environment: Electron-as-node plus the inspect override. */
function engineNodeEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const inspectPort = settings.get().inspectPort
  if (inspectPort !== undefined && inspectPort > 0) {
    env.NODE_OPTIONS = `--inspect=${inspectPort}`
  }
  return env
}

/**
 * Absolute path to the win32 windows-hide preload (`resources/windows-hide.cjs`),
 * or '' when absent. Shipped outside the asar via extraResources so the engine
 * process can load it with a real file path under `ELECTRON_RUN_AS_NODE`.
 */
function windowsHidePreload(): string {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'windows-hide.cjs')
    : join(app.getAppPath(), 'resources', 'windows-hide.cjs')
  return existsSync(path) ? path : ''
}

/**
 * Extra Node CLI args for engine CLI processes: `--require` the win32
 * preload that forces `windowsHide: true` on the engine's own spawns
 * (mechanism B). Windows-only — other platforms inherit a console and never
 * create visible windows; empty when the preload file is missing.
 */
function engineNodeArgs(): string[] {
  if (process.platform !== 'win32') return []
  const preload = windowsHidePreload()
  return preload === '' ? [] : ['--require', preload]
}

/**
 * Resolve the dsh CLI entry, in priority order: explicit `DSH_ENGINE_BIN`
 * override, the packaged engine under `resources/engine`, a `DSH_CHECKOUT`
 * dev checkout's built CLI, then the persisted dev-mode checkout path from
 * settings. Returns '' when nothing resolves.
 */
function resolveDshBin(): string {
  const override = process.env.DSH_ENGINE_BIN
  if (override !== undefined) return override
  const packaged = join(engineDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(packaged)) return packaged
  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined) {
    const dev = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(dev)) return dev
  }
  if (!app.isPackaged) {
    const settingsCheckout = settings.get().checkoutPath
    if (settingsCheckout !== undefined) {
      const dev = join(settingsCheckout, 'apps', 'cli', 'lib', 'bin.js')
      if (existsSync(dev)) return dev
    }
  }
  return ''
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

const harness = new Harness({
  onStateChange: (state) => {
    if (quitting) return
    console.log('[harness] state:', JSON.stringify(state))
    broadcast('harness:state', state)
    if (state.kind === 'starting') engineUiLoaded = false
    // The window starts on the thin status shell and navigates to the real
    // engine UI once the health check passes (and again after a restart).
    if (state.kind === 'running' && !engineUiLoaded && mainWindow !== null) {
      engineUiLoaded = true
      console.log('[shell] loading engine UI:', state.url)
      void mainWindow.loadURL(state.url)
    }
    // An engine failure while the window shows the engine UI must bring the
    // status shell back, or the error would be invisible behind a dead page.
    if ((state.kind === 'error' || state.kind === 'stopped') && engineUiLoaded && mainWindow !== null && !mainWindow.isDestroyed()) {
      engineUiLoaded = false
      console.log('[shell] engine down — returning to the status shell')
      void mainWindow.loadFile(join(import.meta.dirname, 'renderer/index.html'))
    }
  },
  onLog: (line, stream) => {
    console.log(`[engine:${stream}] ${line}`)
    broadcast('harness:log', { line, stream })
  },
})

async function startEngine(): Promise<void> {
  const dshBin = resolveDshBin()
  if (dshBin === '') {
    const detail = '设置 DSH_ENGINE_BIN 或 DSH_CHECKOUT（开发模式），或先运行 scripts/install-engine.mjs（Phase 2）'
    dialog.showErrorBox('dsh-desktop', `未找到 dsh 引擎。${detail}`)
    return
  }
  try {
    await harness.start({ dshBin, env: engineNodeEnv(), nodeArgs: engineNodeArgs() })
  } catch (error) {
    // The harness already pushed an error state; add a friendly diagnosis
    // parsed from the engine's recent stderr.
    const hint = diagnoseStartupFailure(harness.recentLogs)
    const detail = hint === '' ? String(error) : `${hint}\n${String(error)}`
    broadcast('harness:error-detail', detail)
  }
}

async function restartEngine(): Promise<void> {
  await harness.stop()
  await startEngine()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'dsh-desktop',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.loadFile(join(import.meta.dirname, 'renderer/index.html'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Read the system clipboard in the main process and insert it into the
 * focused editable element of the focused window. Works even if the web
 * page's own paste handling is broken or blocked.
 */
async function pasteClipboardIntoFocused(): Promise<void> {
  const text = clipboard.readText()
  if (text === '') return
  pasteTextToFocusedWindow(() => BrowserWindow.getFocusedWindow(), text)
}

function createManagerWindow(): void {
  if (managerWindow !== null) {
    managerWindow.focus()
    return
  }
  managerWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'dsh-desktop 管理',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  managerWindow.loadFile(join(import.meta.dirname, 'renderer/manager.html'))
  managerWindow.webContents.on('did-finish-load', () => {
    console.log('[manager] window loaded')
  })
  managerWindow.on('closed', () => {
    managerWindow = null
  })
}

/**
 * Environment for `dsh plugin` (and other CLI) commands: the system PATH
 * carries pnpm in dev; in a packaged app, a userData shim provides `node`
 * (→ the Electron binary) and a `pnpm` launcher reading pnpm.cjs from the
 * asar, so pnpm's shebangs resolve under our runtime.
 */
function cliCommandEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (app.isPackaged) {
    const shim = join(app.getPath('userData'), 'runtime-bin')
    mkdirSync(shim, { recursive: true })
    const nodeLink = join(shim, 'node')
    if (!existsSync(nodeLink)) {
      try {
        symlinkSync(process.execPath, nodeLink)
      } catch {
        // non-fatal: pnpm may still run when a system node exists
      }
    }
    const pnpmLauncher = join(shim, 'pnpm')
    if (!existsSync(pnpmLauncher)) {
      try {
        const pnpmEntry = join(process.resourcesPath, 'app.asar', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        writeFileSync(pnpmLauncher, `#!/bin/sh\nexec "${process.execPath}" "${pnpmEntry}" "$@"\n`, { mode: 0o755 })
      } catch {
        // non-fatal: plugin install falls back to system pnpm if present
      }
    }
    env.PATH = [shim, env.PATH ?? ''].join(delimiter)
  }
  return env
}

function pluginManager(): PluginManager {
  return new PluginManager({
    profileDir: profileDir(),
    dshBin: resolveDshBin(),
    nodeCommand: process.execPath,
    nodeArgs: engineNodeArgs(),
    env: cliCommandEnv(),
    pluginsLocalDir: join(dshHome(), 'plugins-local'),
  })
}

function tools(): Tools {
  return new Tools({
    dshBin: resolveDshBin(),
    nodeCommand: process.execPath,
    nodeArgs: engineNodeArgs(),
    env: engineNodeEnv(),
    profileDir: profileDir(),
    dshHome: dshHome(),
  })
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'dsh-desktop',
      submenu: [
        { label: '关于 dsh-desktop', click: () => void dialog.showMessageBox({ message: `dsh-desktop\n引擎运行时：Electron 内嵌 Node ${process.versions.node}` }) },
        { type: 'separator' },
        { label: '检查应用更新…', visible: app.isPackaged, click: () => {
          manualUpdateCheck = true
          void checkUpdatesWithFallback()
        } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        // Fallback that never relies on the page's own paste handling: read
        // the system clipboard in the main process and insert it into the
        // focused editable element of the focused window.
        { label: '粘贴剪切板内容到输入框', click: () => { void pasteClipboardIntoFocused() } },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '管理窗口（插件 / 调试 / 设置）', accelerator: 'CmdOrCtrl+,', click: () => createManagerWindow() },
        { label: '重新加载引擎', accelerator: 'CmdOrCtrl+R', click: () => { void restartEngine() } },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开引擎数据目录（$DSH_HOME）', click: () => void shell.openPath(dshHome()) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Wire electron-updater events into visible user experience. Called once at
 * boot; the listeners stay for the app's lifetime.
 *
 * UX rules:
 *  - startup check is silent (no dialog when a new version exists, only logs);
 *  - a downloaded update prompts the user with "restart now / later" —
 *    autoInstallOnAppQuit still covers the "quit later" path;
 *  - errors are logged only (an update failure must never block the app).
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return // updates only exist in packaged builds

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for updates')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`)
    // Manual check → visible confirmation; startup check stays silent.
    if (manualUpdateCheck) {
      manualUpdateCheck = false
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (win !== null && !win.isDestroyed()) {
        void dialog.showMessageBox(win, {
          type: 'info',
          title: 'dsh-desktop 更新',
          message: `发现新版本 v${info.version}`,
          detail: '正在后台下载，下载完成后会提示重启应用。',
          buttons: ['知道了'],
        })
      }
    }
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] no update available')
    if (manualUpdateCheck) {
      manualUpdateCheck = false
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (win !== null && !win.isDestroyed()) {
        void dialog.showMessageBox(win, {
          type: 'info',
          title: 'dsh-desktop 更新',
          message: '已是最新版本',
          buttons: ['知道了'],
        })
      }
    }
  })

  autoUpdater.on('error', (error) => {
    console.error('[updater] error:', error)
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`)
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (win === null || win.isDestroyed()) return
    void dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'dsh-desktop 更新',
        message: `新版本 v${info.version} 已下载完成`,
        detail: '重启应用即可生效。是否立即重启？',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          // quit → before-quit stops the engine → autoInstallOnAppQuit installs.
          app.quit()
        }
      })
  })
}

/**
 * Resolve the update feed (settings choice → probe in auto mode), point
 * electron-updater at it and check. On failure from a non-GitHub source,
 * fall back to GitHub and retry once — a GitCode mirror outage must not hide
 * updates for users who can reach GitHub.
 */
async function checkUpdatesWithFallback(): Promise<void> {
  if (!app.isPackaged) return // updates only exist in packaged builds
  const choice: UpdateSourceChoice = settings.get().updateSource ?? 'auto'
  const source = await resolveSource(choice)
  console.log(`[updater] feed: ${source.id} (${source.name})`)
  autoUpdater.setFeedURL(source.feed)
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (source.id !== 'github') {
      console.warn(`[updater] ${source.id} 源检查失败（${String((error as Error).message ?? error).slice(0, 120)}），降级 GitHub`)
      const github = sourceById('github')
      if (github !== null) {
        autoUpdater.setFeedURL(github.feed)
        await autoUpdater.checkForUpdates()
        return
      }
    }
    console.error('[updater] check failed:', error)
  }
}

async function boot(): Promise<void> {
  createWindow()
  installMenu()
  setupAutoUpdater()
  // Clipboard: let the engine UI (an http://127.0.0.1 page) use the async
  // Clipboard API, and start watching for system clipboard changes.
  allowClipboardPermissions(session.defaultSession)
  clipboardWatcher.start()
  const version = process.versions.node
  if (!nodeSatisfiesEngine(version)) {
    const message = `Electron 内嵌 Node ${version} 不满足引擎要求 ^22.19.0 || >=24.0.0；请升级到 Electron ≥ 40。`
    dialog.showErrorBox('dsh-desktop', message)
    app.quit()
    return
  }
  await startEngine()
  if (process.env.DSH_DESKTOP_OPEN_MANAGER === '1') createManagerWindow()
  if (app.isPackaged && settings.get().autoCheckUpdates === true) {
    void checkUpdatesWithFallback().catch(() => { /* offline or not configured */ })
  }
}

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  clipboardWatcher.stop()
  void harness.stop().finally(() => app.quit())
})
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())

// ── IPC ────────────────────────────────────────────────────────────────────

ipcMain.handle('harness:get-state', () => harness.currentState)
ipcMain.handle('harness:get-logs', () => harness.recentLogs)
ipcMain.handle('harness:restart', () => restartEngine())
ipcMain.handle('app:quit', () => app.quit())
ipcMain.handle('app:open-manager', () => createManagerWindow())

// Clipboard: current text + insert-into-focused-fallback (the menu item and
// the renderer both route through these).
ipcMain.handle('clipboard:read-text', () => clipboard.readText())
ipcMain.handle('clipboard:paste-focused', () => pasteClipboardIntoFocused())

ipcMain.handle('plugins:list', () => pluginManager().list())
ipcMain.handle('plugins:scaffold', async (_event, name: string) => {
  const scaffold = pluginManager().scaffold(name)
  if (!scaffold.ok || scaffold.dir === undefined) return scaffold
  // Mount immediately: file: link + reconcile + engine restart.
  const result = pluginManager().install(`file:${scaffold.dir}`)
  if (result.ok) await restartEngine()
  return { ...scaffold, install: result }
})
ipcMain.handle('plugins:install', async (_event, spec: string) => {
  const result = pluginManager().install(spec)
  if (result.ok) await restartEngine()
  return result
})
ipcMain.handle('plugins:uninstall', async (_event, name: string) => {
  const result = pluginManager().uninstall(name)
  if (result.ok) await restartEngine()
  return result
})
ipcMain.handle('plugins:update', async (_event, name?: string) => {
  const result = pluginManager().update(name)
  if (result.ok) await restartEngine()
  return result
})
ipcMain.handle('plugins:open-profile', () => shell.openPath(profileDir()))

ipcMain.handle('tools:dump-config', () => tools().dumpConfig())
ipcMain.handle('tools:dump-diff', () => {
  const result = tools().dumpConfig()
  const diff = lastDump === '' ? '' : tools().diff(lastDump, result.output)
  lastDump = result.output
  return { ...result, diff }
})
ipcMain.handle('tools:read-patches', () => tools().readPatchFiles())
ipcMain.handle('tools:write-patch', (_event, name: 'profile' | 'home', text: string) => tools().writePatch(name, text))

ipcMain.handle('settings:get', () => settings.get())
ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => settings.update(patch))

ipcMain.handle('updater:engine-version', async () => ({
  installed: installedEngineVersion({ engineDir: engineDir(), dshHome: dshHome() }),
  latest: await latestEngineVersion(),
}))
ipcMain.handle('updater:probe-sources', () => probeAllSources())
ipcMain.handle('updater:backup', () => backupDshHome({ engineDir: engineDir(), dshHome: dshHome() }))
ipcMain.handle('updater:apply', async () => {
  const scripts = ['install-engine.mjs', 'rebuild-engine.mjs']
  let output = ''
  let ok = true
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [join(app.getAppPath(), 'scripts', script)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 600_000,
      windowsHide: true,
    })
    output += `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (result.status !== 0) {
      ok = false
      break
    }
  }
  if (ok) await restartEngine()
  return { ok, output }
})

// ── lifecycle ──────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(boot)
  app.on('window-all-closed', () => {
    app.quit()
  })
}
