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

// ── Manual update check state ───────────────────────────────────────────────
// A menu-driven "检查应用更新" shows instant feedback (a small HUD), settles
// through updater events via `finishManualCheck`, and is guarded against
// re-entry. A hard timeout guarantees the HUD never waits forever.
const UPDATE_CHECK_TIMEOUT_MS = 20_000
let updateCheckInFlight = false
let checkHudWindow: BrowserWindow | null = null

type ManualCheckOutcome =
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }

type ManualCheckResult =
  | { ok: true; outcome: ManualCheckOutcome }
  | { ok: false; error: Error }

/** Settles the in-flight manual check; set by runUpdateCheck, nulled on settle. */
let finishManualCheck: ((result: ManualCheckResult) => void) | null = null

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

/**
 * Install a native right-click context menu on a window. Electron shows no
 * context menu by default, so without this, right-click is a no-op and mouse
 * select + copy (e.g. engine UI messages) is unusable. Items adapt to the
 * click target: editable fields get the full edit menu, selected text gets
 * Copy, and links get copy/open actions.
 */
function installContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []

    if (params.isEditable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    } else if (params.selectionText !== '') {
      template.push(
        { role: 'copy', label: '复制' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    } else {
      template.push({ role: 'selectAll', label: '全选' })
    }

    if (params.linkURL !== '') {
      template.push(
        { type: 'separator' },
        { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
        { label: '打开链接', click: () => void shell.openExternal(params.linkURL) },
      )
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: win })
    }
  })
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
  installContextMenu(mainWindow)
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
  installContextMenu(managerWindow)
  managerWindow.loadFile(join(import.meta.dirname, 'renderer/manager.html'))
  managerWindow.webContents.on('did-finish-load', () => {
    console.log('[manager] window loaded')
  })
  managerWindow.on('closed', () => {
    managerWindow = null
  })
}

/**
 * Environment for spawning Node/CLI helper scripts under Electron-as-node.
 * In dev, the system PATH already carries node/pnpm (mise, nvm, …). In a
 * packaged app the process is launched by the GUI (Finder/start menu) with a
 * minimal PATH (`/usr/bin:/bin:…`), so npm/pnpm from user shells are never
 * found — a userData `runtime-bin` shim provides both:
 *  - `node` (symlink → Electron binary) — with ELECTRON_RUN_AS_NODE=1 the
 *    Electron binary IS node;
 *  - `pnpm` (launcher) → `exec <Electron binary> <asar pnpm.cjs> "$@"`.
 * The shim dir is prepended to PATH, so scripts like install-engine.mjs and
 * `dsh plugin` resolve pnpm with zero system dependencies. Shim write
 * failures are non-fatal (a system pnpm then works as before).
 */
function runtimeBinEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (!app.isPackaged) return env
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
  const pnpmEntry = join(process.resourcesPath, 'app.asar', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmLauncher)) {
    try {
      // install-engine.mjs / plugins spawn `pnpm.cmd` on Windows (PATHEXT is
      // not applied by spawnSync); a .cmd shim is required there, a plain
      // shell launcher elsewhere.
      if (process.platform === 'win32') {
        const cmdLauncher = join(shim, 'pnpm.cmd')
        if (!existsSync(cmdLauncher)) {
          writeFileSync(cmdLauncher, `@"${process.execPath}" "${pnpmEntry}" %*\r\n`)
        }
      } else {
        writeFileSync(pnpmLauncher, `#!/bin/sh\nexec "${process.execPath}" "${pnpmEntry}" "$@"\n`, { mode: 0o755 })
      }
    } catch {
      // non-fatal: plugin install falls back to system pnpm if present
    }
  }
  env.PATH = [shim, env.PATH ?? ''].join(delimiter)
  return env
}

/** Environment for `dsh plugin` (and other CLI) commands. */
function cliCommandEnv(): Record<string, string> {
  return runtimeBinEnv()
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

/** About-dialog text: the dsh-desktop project version and the installed dsh engine version — independent of each other. */
function aboutMessage(): string {
  const engine = installedEngineVersion({ engineDir: engineDir(), dshHome: dshHome() })
  return [
    `dsh-desktop v${app.getVersion()}`,
    `dsh 引擎：${engine !== null ? `v${engine}` : '未安装'}`,
  ].join('\n')
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'dsh-desktop',
      submenu: [
        { label: '关于 dsh-desktop', click: () => void dialog.showMessageBox({ message: aboutMessage() }) },
        { type: 'separator' },
        { id: 'check-updates', label: '检查应用更新…', visible: app.isPackaged, click: () => { void checkUpdatesWithFeedback() } },
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
 *  - a manual check (menu) shows a progress HUD, then settles into a result
 *    dialog — new version / already latest / failed (with retry) / timed out;
 *  - a downloaded update prompts the user with "restart now / later" —
 *    autoInstallOnAppQuit still covers the "quit later" path;
 *  - errors never block the app: startup failures are logged only, manual
 *    check failures surface in the result dialog.
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return // updates only exist in packaged builds

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for updates')
  })

  // Terminal events settle the awaiting manual check via `finishManualCheck`
  // (the HUD closes and the result dialog is shown in checkUpdatesWithFeedback);
  // a startup check stays silent because `finishManualCheck` is null then.
  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`)
    finishManualCheck?.({ ok: true, outcome: { kind: 'available', version: info.version } })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] no update available')
    finishManualCheck?.({ ok: true, outcome: { kind: 'not-available' } })
  })

  autoUpdater.on('error', (error) => {
    console.error('[updater] error:', error)
    finishManualCheck?.({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
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

// ── Manual update check UI ──────────────────────────────────────────────────

/** Small always-on-top HUD shown while a manual check is in flight. */
const CHECK_HUD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #e8e8ec; background: rgba(28, 28, 34, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; box-sizing: border-box;
    user-select: none; cursor: default;
  }
  .spinner {
    width: 24px; height: 24px; border-radius: 50%;
    border: 3px solid rgba(255, 255, 255, 0.22); border-top-color: #4f8cff;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="spinner"></div>
  <div>正在检查更新…</div>
</body>
</html>`

function showCheckingHud(): void {
  if (checkHudWindow !== null) return
  const win = new BrowserWindow({
    width: 280,
    height: 106,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  checkHudWindow = win
  // Clicks pass through: the HUD must never block the app during the wait.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHECK_HUD_HTML)}`)
  win.once('ready-to-show', () => win.show())
  win.center()
  win.on('closed', () => {
    if (checkHudWindow === win) checkHudWindow = null
  })
}

function closeCheckingHud(): void {
  if (checkHudWindow !== null) {
    checkHudWindow.destroy()
    checkHudWindow = null
  }
}

/** Disable/re-label the menu item while a manual check is in flight. */
function setCheckMenuItemBusy(busy: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('check-updates')
  if (item === null || item === undefined) return
  item.enabled = !busy
  item.label = busy ? '正在检查更新…' : '检查应用更新…'
}

function showInfoDialog(message: string, detail?: string): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (win === null || win.isDestroyed()) return Promise.resolve()
  return dialog
    .showMessageBox(win, { type: 'info', title: 'dsh-desktop 更新', message, detail, buttons: ['知道了'] })
    .then(() => undefined)
}

/** Error dialog for a failed/timed-out manual check; resolves true when retrying. */
function showCheckFailedDialog(error: Error): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (win === null || win.isDestroyed()) return Promise.resolve(false)
  return dialog
    .showMessageBox(win, {
      type: 'error',
      title: 'dsh-desktop 更新',
      message: '检查更新失败',
      detail: `错误信息：${error.message.slice(0, 200)}`,
      buttons: ['重试', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => response === 0)
}

/**
 * Await the next terminal updater event (or a hard timeout) for the manual
 * check kicked off by checkUpdatesWithFallback(). Terminal events arrive via
 * `finishManualCheck`; the timeout guarantees the HUD never waits forever.
 */
function runUpdateCheck(): Promise<ManualCheckResult> {
  return new Promise((resolve) => {
    const finish = (result: ManualCheckResult): void => {
      if (finishManualCheck === null) return // already settled (event raced the timeout)
      finishManualCheck = null
      clearTimeout(timer)
      resolve(result)
    }
    finishManualCheck = finish
    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error(`检查超时（${UPDATE_CHECK_TIMEOUT_MS / 1000} 秒），请检查网络后重试`) })
    }, UPDATE_CHECK_TIMEOUT_MS)
    void checkUpdatesWithFallback().catch((error) => {
      finish({ ok: false, error: error instanceof Error ? error : new Error(String(error)) })
    })
  })
}

/**
 * Menu-driven update check with immediate feedback: a progress HUD while
 * checking, then a result dialog — new version (download continues in the
 * background), already latest, or failure/timeout with a retry option.
 * Re-entry is guarded and the retry loop keeps that guard intact.
 */
async function checkUpdatesWithFeedback(): Promise<void> {
  if (!app.isPackaged) return // updates only exist in packaged builds
  if (updateCheckInFlight) return
  updateCheckInFlight = true
  try {
    while (true) {
      setCheckMenuItemBusy(true)
      showCheckingHud()
      const result = await runUpdateCheck()
      closeCheckingHud()
      if (result.ok) {
        if (result.outcome.kind === 'available') {
          await showInfoDialog(`发现新版本 v${result.outcome.version}`, '正在后台下载，下载完成后会提示重启应用。')
        } else {
          await showInfoDialog('已是最新版本')
        }
        return
      }
      const retry = await showCheckFailedDialog(result.error)
      if (!retry) return
      // loop: retry without releasing the in-flight guard or menu busy state
    }
  } finally {
    closeCheckingHud()
    setCheckMenuItemBusy(false)
    updateCheckInFlight = false
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
  // The install/rebuild scripts must see pnpm: use the runtime-bin shim env
  // (a packaged app's process.env.PATH is the minimal GUI PATH and never
  // contains npm/pnpm from user shells — that is what made 应用引擎更新 fail
  // with "neither npm nor pnpm is available on PATH").
  const env = runtimeBinEnv()
  // Packaged: scripts/ lives inside the read-only app.asar and derives the
  // engine dir from its own location; hand it the real Resources/engine
  // explicitly. Dev mode keeps the default (repo resources/engine).
  if (app.isPackaged) env.DSH_ENGINE_DIR = join(process.resourcesPath, 'engine')
  const scripts = ['install-engine.mjs', 'rebuild-engine.mjs']
  let output = ''
  let ok = true
  let exitCode: number | null = null
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [join(app.getAppPath(), 'scripts', script)], {
      env,
      encoding: 'utf8',
      timeout: 600_000,
      windowsHide: true,
    })
    output += `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (result.status !== 0) {
      ok = false
      exitCode = result.status
      break
    }
  }
  if (ok) await restartEngine()
  return { ok, output, exitCode }
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
