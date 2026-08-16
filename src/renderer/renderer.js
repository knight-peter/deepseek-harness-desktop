'use strict'

// Status shell renderer: reflects harness state and logs through the
// contextBridge API. The real application UI lives in the engine's served
// page; this shell only reports lifecycle state.
const api = window.dshDesktop

const statusEl = document.getElementById('status')
const statusText = document.getElementById('status-text')
const urlEl = document.getElementById('url')
const detailEl = document.getElementById('detail')
const logsEl = document.getElementById('logs')
const restartButton = document.getElementById('restart')

const STATE_TEXT = {
  idle: '待机',
  starting: '引擎启动中…',
  running: '运行中',
  stopped: '已停止',
  error: '错误',
}

function render(state) {
  statusEl.className = state.kind
  statusText.textContent = STATE_TEXT[state.kind] ?? state.kind
  restartButton.disabled = state.kind === 'starting'
  if (state.kind === 'running') {
    urlEl.textContent = state.url
    urlEl.href = state.url
  } else {
    urlEl.textContent = ''
    urlEl.removeAttribute('href')
  }
  if (state.kind === 'error') {
    detailEl.textContent = state.message
  } else if (state.kind === 'stopped') {
    detailEl.textContent = `退出码 ${state.code ?? '—'} / 信号 ${state.signal ?? '—'}`
  } else {
    detailEl.textContent = ''
  }
}

function appendLog(entry) {
  const line = document.createElement('div')
  if (entry.stream === 'stderr') line.className = 'log-stderr'
  line.textContent = entry.line
  logsEl.appendChild(line)
  logsEl.scrollTop = logsEl.scrollHeight
}

restartButton.addEventListener('click', () => api.restart())
document.getElementById('manager').addEventListener('click', () => api.openManager())
document.getElementById('quit').addEventListener('click', () => api.quit())

api.getState().then(render)
api.onStateChange(render)
api.onLog(appendLog)
api.onErrorDetail((detail) => {
  detailEl.textContent += `\n${detail}`
})
