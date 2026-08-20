'use strict'

// Manager window renderer: plugins / debug / settings tabs over the
// contextBridge API.
const api = window.dshDesktop

// ── tabs ────────────────────────────────────────────────────────────────────
for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('nav button')) other.classList.remove('active')
    for (const section of document.querySelectorAll('section')) section.classList.remove('active')
    button.classList.add('active')
    document.getElementById(`tab-${button.dataset.tab}`).classList.add('active')
  })
}

// ── shared action log ───────────────────────────────────────────────────────
const actionLog = document.getElementById('action-log')
function logAction(text, kind) {
  const line = document.createElement('div')
  line.className = kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''
  line.textContent = text
  actionLog.appendChild(line)
  actionLog.scrollTop = actionLog.scrollHeight
}

// ── plugins tab ─────────────────────────────────────────────────────────────
const pluginBody = document.querySelector('#plugin-table tbody')

async function refreshPlugins() {
  const plugins = await api.listPlugins()
  pluginBody.replaceChildren()
  for (const plugin of plugins) {
    const row = document.createElement('tr')
    const type = plugin.template ? '<span class="badge template">模板</span>'
      : plugin.bundle ? '<span class="badge bundle">bundle</span>'
      : '<span class="badge">依赖</span>'
    const actions = plugin.template ? ''
      : `<button data-uninstall="${plugin.name}">卸载</button> <button data-update="${plugin.name}">更新</button>`
    row.innerHTML = `<td>${plugin.name}</td><td>${plugin.version}</td><td>${type}</td><td>${actions}</td>`
    pluginBody.appendChild(row)
  }
}

pluginBody.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (button === null) return
  const name = button.dataset.uninstall ?? button.dataset.update
  void (button.dataset.uninstall !== undefined ? api.uninstallPlugin(name) : api.updatePlugin(name))
    .then((result) => {
      logAction(`${button.dataset.uninstall !== undefined ? '卸载' : '更新'} ${name}: exit ${String(result.exitCode)}`, result.ok ? 'ok' : 'error')
      return refreshPlugins()
    })
})

document.getElementById('install-btn').addEventListener('click', () => {
  const kind = document.getElementById('install-kind').value
  let spec = document.getElementById('install-spec').value.trim()
  if (spec === '') return
  if (kind === 'dir' && !spec.startsWith('file:') && !spec.startsWith('link:')) spec = `file:${spec}`
  void api.installPlugin(spec).then((result) => {
    logAction(`安装 ${spec}: exit ${String(result.exitCode)}`, result.ok ? 'ok' : 'error')
    if (!result.ok) logAction(result.output.slice(-800), 'error')
    document.getElementById('install-spec').value = ''
    return refreshPlugins()
  })
})
document.getElementById('scaffold-btn').addEventListener('click', () => {
  const name = document.getElementById('scaffold-name').value.trim()
  if (name === '') return
  void api.scaffoldPlugin(name).then((result) => {
    if (!result.ok) {
      logAction(`新建插件失败：${result.error ?? ''}`, 'error')
      return
    }
    logAction(`已生成并安装 ${result.dir}（exit ${String(result.install.exitCode)}）`, result.install.ok ? 'ok' : 'error')
    if (!result.install.ok) logAction(result.install.output.slice(-800), 'error')
    document.getElementById('scaffold-name').value = ''
    return refreshPlugins()
  })
})
document.getElementById('refresh-btn').addEventListener('click', refreshPlugins)
document.getElementById('open-profile-btn').addEventListener('click', () => api.openProfileDir())
void refreshPlugins()

// ── debug tab ───────────────────────────────────────────────────────────────
const logView = document.getElementById('log-view')

function appendLogEntry(entry) {
  const line = document.createElement('div')
  if (entry.stream === 'stderr') line.className = 'log-stderr'
  line.textContent = entry.line
  logView.appendChild(line)
  logView.scrollTop = logView.scrollHeight
}

api.onLog(appendLogEntry)
void api.getRecentLogs().then((lines) => {
  for (const line of lines) appendLogEntry({ line, stream: 'stdout' })
})

document.getElementById('reload-engine-btn').addEventListener('click', () => api.restart())
document.getElementById('log-clear-btn').addEventListener('click', () => { logView.replaceChildren() })
document.getElementById('log-export-btn').addEventListener('click', async () => {
  const lines = await api.getRecentLogs()
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `dsh-engine-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  anchor.click()
  URL.revokeObjectURL(url)
})

const dumpView = document.getElementById('dump-view')
document.getElementById('dump-btn').addEventListener('click', async () => {
  const result = await api.dumpConfig()
  dumpView.textContent = result.ok ? result.output : `失败 (exit ${String(result.exitCode)})\n${result.output}`
})
document.getElementById('dump-diff-btn').addEventListener('click', async () => {
  const result = await api.dumpDiff()
  dumpView.textContent = result.ok
    ? (result.diff === '' ? '（首次对比：已保存基线，再点一次显示 diff）' : result.diff)
    : `失败 (exit ${String(result.exitCode)})\n${result.output}`
})

const patchTarget = document.getElementById('patch-target')
const patchEditor = document.getElementById('patch-editor')
const patchStatus = document.getElementById('patch-status')

document.getElementById('patch-load-btn').addEventListener('click', async () => {
  const files = await api.readPatches()
  const file = files.find((entry) => entry.name === patchTarget.value)
  if (file === undefined) return
  patchEditor.value = file.exists ? file.content : ''
  patchStatus.textContent = file.exists ? `已加载：${file.path}` : `不存在：${file.path}`
  patchStatus.className = 'muted'
})

document.getElementById('patch-save-btn').addEventListener('click', async () => {
  const result = await api.writePatch(patchTarget.value, patchEditor.value)
  if (!result.ok) {
    patchStatus.textContent = `保存失败：${result.error ?? ''}`
    patchStatus.className = 'err'
    return
  }
  patchStatus.textContent = result.needsRestart ? '已保存（结构性改动：需重启引擎生效）' : '已保存（配置改动：HMR 热生效）'
  patchStatus.className = result.needsRestart ? 'err' : 'ok'
})

// ── settings tab ────────────────────────────────────────────────────────────
const checkoutInput = document.getElementById('checkout-path')
const inspectEnabled = document.getElementById('inspect-enabled')
const inspectPort = document.getElementById('inspect-port')
const autoUpdateCheck = document.getElementById('auto-update-check')
const updateSourceSelect = document.getElementById('update-source')
const probeResult = document.getElementById('probe-result')

void api.getSettings().then((settings) => {
  checkoutInput.value = settings.checkoutPath ?? ''
  inspectEnabled.checked = settings.inspectPort !== undefined
  inspectPort.value = String(settings.inspectPort ?? 9229)
  autoUpdateCheck.checked = settings.autoCheckUpdates === true
  updateSourceSelect.value = settings.updateSource ?? 'auto'
})

document.getElementById('checkout-save').addEventListener('click', async () => {
  const path = checkoutInput.value.trim()
  await api.setSettings({ checkoutPath: path === '' ? undefined : path })
  logAction('设置已保存（重新加载引擎后生效）', 'ok')
})
inspectEnabled.addEventListener('change', () => api.setSettings({ inspectPort: inspectEnabled.checked ? Number(inspectPort.value) : undefined }))
inspectPort.addEventListener('change', () => api.setSettings({ inspectPort: Number(inspectPort.value) }))
autoUpdateCheck.addEventListener('change', () => api.setSettings({ autoCheckUpdates: autoUpdateCheck.checked }))
updateSourceSelect.addEventListener('change', () => api.setSettings({ updateSource: updateSourceSelect.value }))

document.getElementById('probe-source-btn').addEventListener('click', async () => {
  probeResult.textContent = '测速中…'
  const results = await api.probeUpdateSources()
  probeResult.textContent = results
    .map((s) => `${s.name}: ${s.reachable ? `${s.latencyMs}ms` : '不可达'}`)
    .join('　|　')
})

// ── updater ─────────────────────────────────────────────────────────────────
const engineVersionEl = document.getElementById('engine-version')
const updateResult = document.getElementById('update-result')

void api.engineVersion().then((info) => {
  engineVersionEl.textContent = `已安装引擎：${info.installed ?? '未安装'}${info.latest === null ? '' : `　｜　npm 最新：${info.latest}`}`
})

document.getElementById('version-check-btn').addEventListener('click', async () => {
  const info = await api.engineVersion()
  engineVersionEl.textContent = `已安装引擎：${info.installed ?? '未安装'}　｜　npm 最新：${info.latest ?? '（查询失败）'}`
})

document.getElementById('backup-btn').addEventListener('click', async () => {
  const path = await api.backupHome()
  updateResult.textContent = path === null ? '$DSH_HOME 不存在，无需备份' : `备份完成：${path}`
  updateResult.className = 'ok'
})

document.getElementById('apply-update-btn').addEventListener('click', async () => {
  updateResult.textContent = '正在重装引擎（npm install，可能耗时数分钟）…'
  updateResult.className = 'muted'
  const result = await api.applyUpdate()
  if (result.ok) {
    updateResult.textContent = '引擎更新完成，已重启'
  } else {
    const hint = result.output.includes('neither npm nor pnpm is available on PATH')
      ? '\n（发布版内置 pnpm 垫片，仍报此错说明运行时未把垫片加入 PATH——请将应用升级到修复版本）'
      : ''
    updateResult.textContent = `引擎更新失败（exit ${String(result.exitCode)}）：\n${result.output.slice(-1200)}${hint}`
  }
  updateResult.className = result.ok ? 'ok' : 'err'
})
