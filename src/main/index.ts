/**
 * dsh-desktop main process: single-instance lock, window, IPC, and engine
 * lifecycle. The engine runs as a child process under Electron's embedded
 * Node (`ELECTRON_RUN_AS_NODE=1`); the window is a thin status shell over
 * the real web UI served by the engine.
 * @module dsh-desktop/main
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Harness, nodeSatisfiesEngine } from './harness.js'

let mainWindow: BrowserWindow | null = null
let engineUiLoaded = false

const harness = new Harness({
  onStateChange: (state) => {
    console.log('[harness] state:', JSON.stringify(state))
    mainWindow?.webContents.send('harness:state', state)
    if (state.kind === 'starting') engineUiLoaded = false
    // The window starts on the thin status shell and navigates to the real
    // engine UI once the health check passes (and again after a restart).
    if (state.kind === 'running' && !engineUiLoaded && mainWindow !== null) {
      engineUiLoaded = true
      console.log('[shell] loading engine UI:', state.url)
      void mainWindow.loadURL(state.url)
    }
  },
  onLog: (line, stream) => {
    console.log(`[engine:${stream}] ${line}`)
    mainWindow?.webContents.send('harness:log', { line, stream })
  },
})

/**
 * Resolve the dsh CLI entry, in priority order: explicit `DSH_ENGINE_BIN`
 * override, the packaged engine under `resources/engine`, a `DSH_CHECKOUT`
 * dev checkout's built CLI, then — dev mode only — a sibling
 * `deepseek-harness` checkout next to this repository. Returns '' when
 * nothing resolves.
 */
function resolveDshBin(): string {
  const override = process.env.DSH_ENGINE_BIN
  if (override !== undefined) return override
  const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const packaged = join(resources, 'engine', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(packaged)) return packaged
  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined) {
    const dev = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(dev)) return dev
  }
  if (!app.isPackaged) {
    const sibling = join(app.getAppPath(), '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
    if (existsSync(sibling)) return sibling
  }
  return ''
}

async function startEngine(): Promise<void> {
  const dshBin = resolveDshBin()
  if (dshBin === '') {
    const detail = '设置 DSH_ENGINE_BIN 或 DSH_CHECKOUT（或将本仓库放在 deepseek-harness 兄弟目录后重试），或先运行 scripts/install-engine.ts（Phase 2）'
    dialog.showErrorBox('dsh-desktop', `未找到 dsh 引擎。${detail}`)
    return
  }
  try {
    await harness.start({ dshBin })
  } catch (error) {
    // The harness already pushed an error state; surface the reason on the UI.
    mainWindow?.webContents.send('harness:error-detail', String(error))
  }
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

async function boot(): Promise<void> {
  createWindow()
  const version = process.versions.node
  if (!nodeSatisfiesEngine(version)) {
    const message = `Electron 内嵌 Node ${version} 不满足引擎要求 ^22.19.0 || >=24.0.0；请升级到 Electron ≥ 40。`
    dialog.showErrorBox('dsh-desktop', message)
    app.quit()
    return
  }
  await startEngine()
}

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void harness.stop().finally(() => app.quit())
})
process.on('SIGINT', () => app.quit())
process.on('SIGTERM', () => app.quit())

ipcMain.handle('harness:get-state', () => harness.currentState)
ipcMain.handle('harness:restart', async () => {
  await harness.stop()
  await startEngine()
})
ipcMain.handle('app:quit', () => {
  app.quit()
})

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
