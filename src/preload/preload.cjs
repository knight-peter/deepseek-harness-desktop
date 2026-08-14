'use strict'

// Sandboxed preload: exposes the harness API to the status shell renderer
// through the context bridge only — no Node access in the renderer.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  getState: () => ipcRenderer.invoke('harness:get-state'),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('harness:state', listener)
    return () => ipcRenderer.removeListener('harness:state', listener)
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry)
    ipcRenderer.on('harness:log', listener)
    return () => ipcRenderer.removeListener('harness:log', listener)
  },
  onErrorDetail: (callback) => {
    const listener = (_event, detail) => callback(detail)
    ipcRenderer.on('harness:error-detail', listener)
    return () => ipcRenderer.removeListener('harness:error-detail', listener)
  },
  restart: () => ipcRenderer.invoke('harness:restart'),
  quit: () => ipcRenderer.invoke('app:quit'),
})
