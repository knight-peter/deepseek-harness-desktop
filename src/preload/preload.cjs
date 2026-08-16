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

  // plugins (Phase 3)
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  scaffoldPlugin: (name) => ipcRenderer.invoke('plugins:scaffold', name),
  installPlugin: (spec) => ipcRenderer.invoke('plugins:install', spec),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugins:uninstall', name),
  updatePlugin: (name) => ipcRenderer.invoke('plugins:update', name),
  openProfileDir: () => ipcRenderer.invoke('plugins:open-profile'),

  // tools (Phase 4)
  dumpConfig: () => ipcRenderer.invoke('tools:dump-config'),
  dumpDiff: () => ipcRenderer.invoke('tools:dump-diff'),
  readPatches: () => ipcRenderer.invoke('tools:read-patches'),
  writePatch: (name, text) => ipcRenderer.invoke('tools:write-patch', name, text),

  // settings (Phase 6)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // updater (Phase 5)
  engineVersion: () => ipcRenderer.invoke('updater:engine-version'),
  backupHome: () => ipcRenderer.invoke('updater:backup'),
  applyUpdate: () => ipcRenderer.invoke('updater:apply'),
})
