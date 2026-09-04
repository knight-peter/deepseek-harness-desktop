'use strict'

// Sandboxed preload: exposes the harness, plugin, tool, settings, and
// updater APIs to the status shell and the manager window through the
// context bridge only — no Node access in the renderer.
const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('dshDesktop', {
  // harness
  getState: () => ipcRenderer.invoke('harness:get-state'),
  getRecentLogs: () => ipcRenderer.invoke('harness:get-logs'),
  onStateChange: (callback) => on('harness:state', callback),
  onLog: (callback) => on('harness:log', callback),
  onErrorDetail: (callback) => on('harness:error-detail', callback),
  restart: () => ipcRenderer.invoke('harness:restart'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openManager: () => ipcRenderer.invoke('app:open-manager'),
  // app (shell) update: state + quiet manual check + restart-install + pushes
  appUpdateState: () => ipcRenderer.invoke('app:update-state'),
  appCheckUpdates: () => ipcRenderer.invoke('app:check-updates'),
  appApplyUpdate: () => ipcRenderer.invoke('app:apply-update'),
  onAppUpdateState: (callback) => on('app:update-state', callback),
  onEngineUpdateState: (callback) => on('updater:engine-state', callback),

  // plugins (Phase 3 + M1/M2)
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  scaffoldPlugin: (name) => ipcRenderer.invoke('plugins:scaffold', name),
  installPlugin: (spec) => ipcRenderer.invoke('plugins:install', spec),
  approveInstall: (spec, packages) => ipcRenderer.invoke('plugins:approve-install', { spec, packages }),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugins:uninstall', name),
  updatePlugin: (name) => ipcRenderer.invoke('plugins:update', name),
  checkPluginUpdates: () => ipcRenderer.invoke('plugins:check-updates'),
  // Startup/lazy plugin version sweep results: cached in main, or kicked off
  // quietly and pushed here once they land.
  getPluginUpdates: () => ipcRenderer.invoke('plugins:startup-updates'),
  onPluginUpdates: (callback) => on('plugins:updates', callback),
  onPluginProgress: (callback) => on('plugins:progress', callback),
  openProfileDir: () => ipcRenderer.invoke('plugins:open-profile'),

  // tools (Phase 4)
  dumpConfig: () => ipcRenderer.invoke('tools:dump-config'),
  dumpDiff: () => ipcRenderer.invoke('tools:dump-diff'),
  readPatches: () => ipcRenderer.invoke('tools:read-patches'),
  writePatch: (name, text) => ipcRenderer.invoke('tools:write-patch', name, text),

  // settings (Phase 6)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // clipboard (system clipboard bridge; `clipboard:change` fires whenever
  // the plain-text clipboard content changes anywhere on the system)
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  pasteClipboardIntoFocused: () => ipcRenderer.invoke('clipboard:paste-focused'),
  onClipboardChange: (callback) => on('clipboard:change', callback),

  // updater (Phase 5); force=true bypasses the engine-version cache
  engineVersion: (force = false) => ipcRenderer.invoke('updater:engine-version', force),
  backupHome: () => ipcRenderer.invoke('updater:backup'),
  applyUpdate: () => ipcRenderer.invoke('updater:apply'),
  probeUpdateSources: () => ipcRenderer.invoke('updater:probe-sources'),
})
