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
    // 只显示 origin：引擎 0.1.5 起 URL 带 `?token=`，而这是换取会话 cookie 的
    // 凭据——状态页常被截图/分享，把它渲染成可点击链接会直接泄露引擎访问权。
    // origin 已足够让用户知道引擎跑在哪个地址、点开看是否在监听。
    let origin = state.url
    try {
      origin = new URL(state.url).origin
    } catch {
      // 解析失败就原样显示（旧引擎的裸 URL 本就不含凭据）
    }
    urlEl.textContent = origin
    urlEl.href = origin
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
