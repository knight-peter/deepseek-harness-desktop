'use strict'

// Manager window renderer: plugins / debug / settings tabs over the
// contextBridge API.
const api = window.dshDesktop

// ── tabs ────────────────────────────────────────────────────────────────────
for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => {
    clearToasts() // 切换页签时收起正在显示的提示
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
  line.className = kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : ''
  line.textContent = text
  actionLog.appendChild(line)
  actionLog.scrollTop = actionLog.scrollHeight
}

// ── toasts（右上角轻提示：按结果着色，数秒自动消失；悬停暂停、× 关闭）────────
const toastRoot = document.createElement('div')
toastRoot.id = 'toast-root'
document.body.appendChild(toastRoot)

let busyToast = null
// 穿透式 toast 不能交互，停留时间尽量短：ok/info 3s，warn 5s，err 6s（busy 由任务结束/下一条替换）。
const TOAST_DURATION = { ok: 3000, info: 3000, warn: 5000, err: 6000 }
// busy 条最短可见时间：结果来得太快时先让 busy 停留够久，避免“没看清就变第二条”。
const MIN_BUSY_MS = 450

/** 同时只保留一条：新提示出现前直接清空旧提示（含正在淡出的），避免两条叠一起。 */
function clearToasts() {
  while (toastRoot.firstChild !== null) toastRoot.firstChild.remove()
  busyToast = null
}

/** 真正往 DOM 里放一条 toast 的内部实现。 */
function notifyNow(text, kind) {
  clearToasts() // 同一时间只显示一条
  const el = document.createElement('div')
  el.className = `toast ${kind === 'info' ? '' : kind}`.trim()
  if (kind === 'busy') {
    const spin = document.createElement('span')
    spin.className = 'spin'
    el.appendChild(spin)
  }
  const body = document.createElement('span')
  body.textContent = text
  el.appendChild(body)
  toastRoot.appendChild(el)
  if (kind === 'busy') {
    el._born = Date.now()
    busyToast = el
    return el
  }
  const duration = TOAST_DURATION[kind] ?? TOAST_DURATION.info
  setTimeout(() => dismissToast(el), duration)
  return el
}

/** 显示一条顶部居中的穿透式 toast（不挡点击/视线）。kind: 'ok' | 'warn' | 'err' | 'info' | 'busy'（busy 不自动消失）。 */
function notify(text, kind = 'info') {
  // busy 刚出现就被结果替换时，先让 busy 显示满 MIN_BUSY_MS 再淡出换成结果，
  // 避免“第一条一闪而过、紧接着又一条”的观感。
  if (busyToast !== null && kind !== 'busy') {
    const age = Date.now() - (busyToast._born ?? Date.now())
    if (age < MIN_BUSY_MS) {
      const el = busyToast
      busyToast = null
      setTimeout(() => { dismissToast(el); notifyNow(text, kind) }, MIN_BUSY_MS - age)
      return el
    }
  }
  return notifyNow(text, kind)
}

/** instant=true 立即移除（用于被新提示替换）；否则淡出后移除。 */
function dismissToast(el, instant = false) {
  if (el === null || el === undefined || el.dataset.leaving === '1') return
  el.dataset.leaving = '1'
  if (busyToast === el) busyToast = null
  if (instant) { el.remove(); return }
  el.classList.add('toast-leave')
  setTimeout(() => el.remove(), 200)
}

// ── plugins tab ─────────────────────────────────────────────────────────────
const pluginBody = document.querySelector('#plugin-table tbody')
const pluginConsole = document.getElementById('plugin-console')
const issueBar = document.getElementById('issue-bar')
const issueText = document.getElementById('issue-text')
const approveBtn = document.getElementById('approve-btn')
const issueOpenProfileBtn = document.getElementById('issue-open-profile-btn')

// Latest registry version per installed plugin (only registry-checkable deps
// appear here): a value equal to the installed version renders「最新」, a
// greater/different one renders「可更新 → x.y.z」plus an update button.
let latestByName = new Map()
let pendingSpec = ''
let pendingPackages = []
const installHelpPanel = document.getElementById('install-help')

function setBusy(value) {
  for (const id of ['install-btn', 'scaffold-btn', 'refresh-btn', 'check-updates-btn', 'update-all-btn', 'approve-btn']) {
    const element = document.getElementById(id)
    if (element !== null) element.disabled = value
  }
}

// 「开发调试」页签内的操作反馈（独立一条，紧跟脚手架区）。
const devStatus = document.getElementById('dev-status')
function devNotice(text, kind) {
  if (devStatus === null) return
  devStatus.textContent = text
  devStatus.className = kind === undefined ? 'muted' : kind
}

function appendConsole(chunk) {
  pluginConsole.hidden = false
  pluginConsole.textContent += chunk
  if (pluginConsole.textContent.length > 40000) {
    pluginConsole.textContent = pluginConsole.textContent.slice(-40000)
  }
  pluginConsole.scrollTop = pluginConsole.scrollHeight
}

function clearConsole() {
  pluginConsole.textContent = ''
  pluginConsole.hidden = true
}

function hideIssue() {
  issueBar.hidden = true
  approveBtn.hidden = true
  issueOpenProfileBtn.hidden = true
}

/** Show the remediation bar (approve & re-install / open profile). */
function showIssue(message, options) {
  issueText.textContent = message
  approveBtn.hidden = options.approve !== true
  issueOpenProfileBtn.hidden = options.openProfile !== true
  if (options.approve === true) {
    pendingSpec = options.spec ?? ''
    pendingPackages = options.packages ?? []
    approveBtn.textContent = pendingPackages.length > 0 ? `放行并重装（${pendingPackages.join(', ')}）` : '放行并重装'
  }
  issueBar.hidden = false
}

function kindText(plugin) {
  if (plugin.template) return { text: '模板', cls: 'template' }
  const tags = []
  if (plugin.bundle) tags.push('bundle')
  if (plugin.client) tags.push('客户端')
  if (tags.length === 0) return { text: '依赖', cls: 'dep' }
  return { text: tags.join('·'), cls: plugin.client ? 'client' : 'bundle' }
}

// 与主进程一致的 semver 比较：「可更新」= 最新版 > 已装版（0.1.8 对 0.1.6 不是更新）。
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
function compareVersions(a, b) {
  const ma = SEMVER_RE.exec(String(a).trim())
  const mb = SEMVER_RE.exec(String(b).trim())
  if (ma === null || mb === null) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 1; i <= 3; i++) {
    const x = Number(ma[i])
    const y = Number(mb[i])
    if (x !== y) return x < y ? -1 : 1
  }
  const preA = ma[4]
  const preB = mb[4]
  if (preA === undefined && preB === undefined) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) {
      const nx = Number(x)
      const ny = Number(y)
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    if (numericX !== numericY) return numericX ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 某已装版本相对某最新版是否“可更新”。 */
function isUpdatable(installed, latest) {
  return latest !== undefined && latest !== null
    && installed !== undefined && installed !== null
    && compareVersions(latest, installed) > 0
}

async function refreshPlugins() {
  const plugins = await api.listPlugins()
  pluginBody.replaceChildren()
  let outdatedCount = 0
  for (const plugin of plugins) {
    const row = document.createElement('tr')
    const kind = kindText(plugin)
    const latest = plugin.template ? undefined : latestByName.get(plugin.name)
    const outdated = isUpdatable(plugin.version, latest)
    if (outdated) outdatedCount += 1
    // 版本列：能查到 registry 最新版时标出「最新」或「可更新 → 版本号」；
    // 更新按钮只在确有可更新版本时才出现；模板层随引擎更新，不参与。
    let versionHtml = plugin.version
    if (!plugin.template && latest !== undefined) {
      versionHtml = outdated
        ? `${plugin.version} <span class="badge stale">可更新 → ${latest}</span>`
        : `${plugin.version} <span class="badge latest">最新</span>`
    }
    let actions = ''
    if (!plugin.template) {
      actions = outdated
        ? `<button class="primary" data-update="${plugin.name}">更新到 ${latest}</button> <button data-uninstall="${plugin.name}">卸载</button>`
        : `<button data-uninstall="${plugin.name}">卸载</button>`
    }
    row.innerHTML = `<td>${plugin.name}</td><td>${versionHtml}</td><td><span class="badge ${kind.cls}">${kind.text}</span></td><td>${actions}</td>`
    pluginBody.appendChild(row)
  }
  // 「全部更新」按钮随可更新数量显示（0 个时保持普通文字与提示）。
  const updateAllBtn = document.getElementById('update-all-btn')
  if (outdatedCount > 0) {
    updateAllBtn.textContent = `全部更新（${outdatedCount}）`
    updateAllBtn.title = `把版本列标了「可更新」的 ${outdatedCount} 个插件一次性全部更新`
  } else {
    updateAllBtn.textContent = '全部更新'
    updateAllBtn.title = '当前没有可更新的插件（可先点「检查更新」）'
  }
}

/** Apply one version-check result set (replaces any earlier state). */
async function applyUpdateEntries(entries) {
  latestByName = new Map()
  for (const entry of entries) {
    // Keep every checkable registry plugin: equality means「最新」, a
    // difference means「可更新」. Entries without a fetched latest (offline /
    // unknown) stay absent so the row shows neither badge nor update button.
    if (entry.latest !== null && entry.latest !== undefined) {
      latestByName.set(entry.name, entry.latest)
    }
  }
  await refreshPlugins()
}

/** How many installed plugins currently have an update available. */
async function countOutdated() {
  const plugins = await api.listPlugins()
  let count = 0
  for (const plugin of plugins) {
    const latest = plugin.template ? undefined : latestByName.get(plugin.name)
    if (isUpdatable(plugin.version, latest)) count += 1
  }
  return count
}

/** One-line-per-added-plugin summary lines from an install result. */
function describeInstall(result) {
  const lines = []
  const summary = result?.summary
  if (summary === null || summary === undefined) return lines
  for (const info of summary.added) {
    const tag = info.bundle && info.client ? 'bundle 分层 + 客户端'
      : info.bundle ? 'bundle 分层'
      : info.client ? '客户端（未声明 bundle patch）'
      : '普通依赖'
    lines.push(`已安装 ${info.name}@${info.version}（${tag}）`)
  }
  if (summary.delta.bundlesAdded.length > 0) lines.push(`已加入 bundle 分层：${summary.delta.bundlesAdded.join(', ')}`)
  if (summary.delta.removed.length > 0) lines.push(`移除依赖：${summary.delta.removed.join(', ')}`)
  for (const warning of summary.warnings) lines.push(`注意：${warning}`)
  return lines
}

/** 安装/脚手架的结果行：全部进底部日志，另用一条 toast 摘要提示（限 6 行）。 */
function emitSummaryLines(lines, fallbackKind) {
  if (lines.length === 0) return
  const hasWarning = lines.some((line) => line.startsWith('注意：'))
  for (const line of lines) {
    if (line.startsWith('注意：')) logAction(line, 'warn')
    else logAction(line, 'ok')
  }
  const shown = lines.slice(0, 6)
  let text = shown.join('\n')
  if (lines.length > shown.length) text += `\n…共 ${lines.length} 行，详见底部日志`
  notify(text, hasWarning ? 'warn' : fallbackKind)
}

/** Route an install outcome to toast/banner/logs; returns true when ok. */
function renderMutationFailure(result, spec) {
  const issue = result?.issue ?? { kind: 'none' }
  const tail = (result?.output ?? '').slice(-600)
  if (issue.kind === 'build-approval') {
    const packages = issue.packages ?? []
    notify(`需要放行构建脚本：${packages.join(', ') || '（未能识别包名）'}`, 'warn')
    showIssue(`${issue.hint ?? ''}\n${packages.join(', ') || '请在下方放行，或手动在 profile 的 pnpm-workspace.yaml 配置 allowBuilds。'}`,
      { approve: true, spec, packages, openProfile: true })
  } else if (issue.kind === 'git-prepare') {
    notify('git 插件的 prepare 构建脚本被 pnpm 拦截，需放行后才能安装', 'warn')
    showIssue(issue.hint ?? '', { approve: true, spec, packages: issue.packages ?? [], openProfile: true })
  } else if (issue.kind === 'pnpm-missing' || issue.kind === 'registry' || issue.kind === 'network') {
    notify(`安装失败：${issue.hint ?? `exit ${String(result?.exitCode)}`}`, 'err')
    hideIssue()
  } else {
    notify(`安装失败（exit ${String(result?.exitCode)}），详见底部日志`, 'err')
    hideIssue()
  }
  if (tail !== '') logAction(tail, 'error')
}

async function renderInstallResult(result, spec) {
  if (result.ok) {
    const lines = describeInstall(result)
    lines.unshift(`安装成功：${spec}`)
    const skipped = result.warningPackages ?? []
    if (skipped.length > 0) lines.push(`注意：以下依赖构建脚本未执行：${skipped.join(', ')}（可放行后重建）`)
    emitSummaryLines(lines, 'ok')
    if (skipped.length > 0) {
      showIssue(`安装成功，但 ${skipped.join(', ')} 的构建脚本被跳过。若这些是原生模块，请放行并重装以完成编译。`, { approve: true, spec, packages: skipped, openProfile: true })
    } else {
      hideIssue()
    }
    return true
  }
  renderMutationFailure(result, spec)
  return false
}

async function performInstall(spec) {
  hideIssue()
  clearConsole()
  setBusy(true)
  appendConsole(`> dsh plugin --profile web add ${spec}\n`)
  notify(`正在安装 ${spec}…（pnpm 运行中，最长 5 分钟）`, 'busy')
  const result = await api.installPlugin(spec)
  setBusy(false)
  dismissToast(busyToast)
  await renderInstallResult(result, spec)
  await refreshPlugins()
}

async function performMutation(call, describeText) {
  hideIssue()
  clearConsole()
  setBusy(true)
  notify(`${describeText}…`, 'busy')
  const result = await call()
  setBusy(false)
  dismissToast(busyToast)
  if (result.ok) {
    notify(`${describeText}成功（引擎已重启）`, 'ok')
    logAction(`${describeText}成功`, 'ok')
  } else {
    notify(`${describeText}失败（exit ${String(result.exitCode)}），详见底部日志`, 'err')
    logAction(`${describeText}失败（exit ${String(result.exitCode)}）`, 'error')
    logAction((result.output ?? '').slice(-600), 'error')
  }
  await refreshPlugins()
  return result.ok
}

// Live command output from the main process.
api.onPluginProgress(({ chunk }) => appendConsole(chunk))

document.getElementById('install-btn').addEventListener('click', () => {
  const kind = document.getElementById('install-kind').value
  let spec = document.getElementById('install-spec').value.trim()
  if (spec === '') return
  if (kind === 'dir' && !spec.startsWith('file:') && !spec.startsWith('link:')) spec = `file:${spec}`
  void performInstall(spec).then(() => {
    document.getElementById('install-spec').value = ''
  })
})

document.getElementById('scaffold-btn').addEventListener('click', async () => {
  const name = document.getElementById('scaffold-name').value.trim()
  if (name === '') return
  hideIssue()
  clearConsole()
  setBusy(true)
  notify(`正在新建并安装插件 ${name}…`, 'busy')
  devNotice(`正在新建并安装插件 ${name}…`)
  const result = await api.scaffoldPlugin(name)
  setBusy(false)
  dismissToast(busyToast)
  if (!result.ok) {
    notify(`新建插件失败：${result.error ?? ''}`, 'err')
    logAction(result.error ?? '新建插件失败', 'error')
    devNotice(`新建插件失败：${result.error ?? ''}`, 'err')
  } else if (result.install.ok) {
    const lines = describeInstall(result.install)
    lines.unshift(`已生成并安装 ${result.dir}`)
    emitSummaryLines(lines, 'ok')
    hideIssue()
    devNotice(`已生成并安装 ${result.dir}，引擎已重启。`, 'ok')
  } else {
    notify(`模板已生成（${result.dir}），但安装失败，请按提示处理`, 'err')
    renderMutationFailure(result.install, `file:${result.dir}`)
    devNotice(`模板已生成（${result.dir}），但安装失败：请按提示放行或查看下方输出。`, 'err')
  }
  await refreshPlugins()
})

// 放行构建脚本并重装（approveBuilds → pnpm install → 重跑 add → 重启引擎）
approveBtn.addEventListener('click', async () => {
  const spec = pendingSpec
  const packages = pendingPackages.slice()
  if (spec === '' || packages.length === 0) return
  hideIssue()
  clearConsole()
  setBusy(true)
  appendConsole(`> pnpm-workspace.yaml: allowBuilds += ${packages.join(', ')}\n`)
  notify(`放行构建脚本：${packages.join(', ')} → 重跑安装 ${spec}`, 'busy')
  const result = await api.approveInstall(spec, packages)
  setBusy(false)
  dismissToast(busyToast)
  if (!result.ok) {
    const reason = result.approve ?? { exitCode: null, output: '' }
    notify(`放行失败（exit ${String(reason.exitCode)}），详见底部日志`, 'err')
    logAction((reason.output ?? '').slice(-600), 'error')
    await refreshPlugins()
    return
  }
  await renderInstallResult(result.install, spec)
  await refreshPlugins()
})

pluginBody.addEventListener('click', async (event) => {
  const button = event.target.closest('button')
  if (button === null) return
  const name = button.dataset.uninstall ?? button.dataset.update
  if (button.dataset.uninstall !== undefined) {
    const ok = await performMutation(() => api.uninstallPlugin(name), `卸载 ${name}`)
    if (ok) latestByName.delete(name)
  } else if (button.dataset.update !== undefined) {
    const ok = await performMutation(() => api.updatePlugin(name), `更新 ${name}`)
    // 更新后本行版本信息作废：移除记录，等待下一次「检查更新」给出新结论。
    if (ok) latestByName.delete(name)
    await refreshPlugins()
  }
})

document.getElementById('refresh-btn').addEventListener('click', async () => {
  // 刷新是本地即时读列表：不弹“正在刷新”busy，避免一闪而过又弹第二条；直接给一条结果。
  let failed = false
  try {
    await refreshPlugins()
  } catch (err) {
    failed = true
    notify(`刷新失败：${String(err?.message ?? err)}`, 'err')
  }
  if (!failed) {
    const count = pluginBody.querySelectorAll('tr').length
    notify(`已刷新：当前共 ${count} 个已装插件`, 'ok')
  }
})
document.getElementById('open-profile-btn').addEventListener('click', () => api.openProfileDir())
issueOpenProfileBtn.addEventListener('click', () => api.openProfileDir())

document.getElementById('check-updates-btn').addEventListener('click', async () => {
  setBusy(true)
  hideIssue()
  notify('正在向 npm registry 查询所有已装插件的最新版本…', 'busy')
  const updates = await api.checkPluginUpdates()
  setBusy(false)
  dismissToast(busyToast)
  await applyUpdateEntries(updates)
  const staleCount = await countOutdated()
  const failed = updates.filter((entry) => entry.latest === null).length
  if (staleCount > 0) {
    notify(`发现 ${staleCount} 个插件可更新（版本列已标「可更新 → 版本号」），点行内「更新到 …」或「全部更新」。${failed > 0 ? `另有 ${failed} 个查询失败（可能离线）。` : ''}`, 'warn')
  } else if (failed > 0) {
    notify(`未能查询 npm registry（${failed} 个失败），请检查网络后重试。`, 'err')
  } else {
    notify('检查完成：所有已装插件均为最新（版本列已标「最新」）。', 'ok')
  }
})

document.getElementById('update-all-btn').addEventListener('click', async () => {
  const staleCount = await countOutdated()
  if (staleCount === 0) {
    notify('没有可更新的插件（可先点「检查更新」）。', 'warn')
    return
  }
  const ok = await performMutation(() => api.updatePlugin(undefined), `更新全部（${staleCount} 个）`)
  if (ok) {
    latestByName = new Map()
    await refreshPlugins()
  }
})

// 安装帮助：问号按钮展开/收起帮助面板。
document.getElementById('install-help-btn').addEventListener('click', () => {
  installHelpPanel.hidden = !installHelpPanel.hidden
})

// 开发调试总帮助：? 按钮展开/收起。
document.getElementById('dev-help-btn').addEventListener('click', () => {
  document.getElementById('dev-help').hidden = !document.getElementById('dev-help').hidden
})

// Startup/lazy version sweep results (main keeps the cache; a sweep that
// finishes after this window opened is pushed here).
api.onPluginUpdates((entries) => {
  if (!Array.isArray(entries)) return
  void (async () => {
    await applyUpdateEntries(entries)
    const count = await countOutdated()
    if (count > 0) {
      notify(`启动检查：发现 ${count} 个插件有新版本（版本列已标「可更新 → 版本号」）。`, 'warn')
    }
  })()
})

// First paint: read the startup sweep result from main (kicks one lazily when
// the app booted before any plugin existed), then render 最新 / 可更新 marks.
void (async () => {
  await refreshPlugins()
  const cached = await api.getPluginUpdates()
  if (cached !== null && Array.isArray(cached)) {
    await applyUpdateEntries(cached)
    const count = await countOutdated()
    if (count > 0) {
      notify(`启动检查：发现 ${count} 个插件有新版本（版本列已标「可更新 → 版本号」）。`, 'warn')
    }
  }
})()

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
// （开发向设置已迁至「开发调试」页签，这里只剩引擎/应用更新与更新源）
const checkoutInput = document.getElementById('checkout-path')
const inspectEnabled = document.getElementById('inspect-enabled')
const inspectPort = document.getElementById('inspect-port')
const updateSourceSelect = document.getElementById('update-source')
const probeResult = document.getElementById('probe-result')

void api.getSettings().then((settings) => {
  checkoutInput.value = settings.checkoutPath ?? ''
  inspectEnabled.checked = settings.inspectPort !== undefined
  inspectPort.value = String(settings.inspectPort ?? 9229)
  updateSourceSelect.value = settings.updateSource ?? 'auto'
})

document.getElementById('checkout-save').addEventListener('click', async () => {
  const path = checkoutInput.value.trim()
  await api.setSettings({ checkoutPath: path === '' ? undefined : path })
  logAction('引擎来源已保存（重新加载引擎后生效）', 'ok')
  devNotice('引擎来源已保存：重新加载引擎后生效。', 'ok')
})
inspectEnabled.addEventListener('change', () => {
  void api.setSettings({ inspectPort: inspectEnabled.checked ? Number(inspectPort.value) : undefined })
  logAction(`引擎调试端口已${inspectEnabled.checked ? `设为 ${inspectPort.value}` : '关闭'}（重新加载引擎后生效）`, 'ok')
})
inspectPort.addEventListener('change', () => {
  void api.setSettings({ inspectPort: Number(inspectPort.value) })
  logAction(`引擎调试端口已改为 ${inspectPort.value}（重新加载引擎后生效）`, 'ok')
})
updateSourceSelect.addEventListener('change', () => api.setSettings({ updateSource: updateSourceSelect.value }))

const probeSourceBtn = document.getElementById('probe-source-btn')
document.getElementById('probe-source-btn').addEventListener('click', async () => {
  probeResult.textContent = '测速中…'
  setBtnBusy(probeSourceBtn, true)
  try {
    const results = await api.probeUpdateSources()
    probeResult.textContent = results
      .map((s) => `${s.name}: ${s.reachable ? `${s.latencyMs}ms` : '不可达'}`)
      .join('　|　')
  } finally {
    setBtnBusy(probeSourceBtn, false)
  }
})

// ── 按钮忙碌（loading spinner）──────────────────────────────────────────────
function setBtnBusy(button, busy) {
  if (button === null) return
  button.disabled = busy
  button.classList.toggle('btn-busy', busy)
}

// ── 引擎更新 ────────────────────────────────────────────────────────────────
const engineVersionEl = document.getElementById('engine-version')
const versionCheckBtn = document.getElementById('version-check-btn')
const backupBtn = document.getElementById('backup-btn')
const engineApplyBtn = document.getElementById('engine-apply-btn')
const updateResult = document.getElementById('update-result')

/** 引擎更新区的操作结果（带颜色）。 */
function setUpdateResult(text, kind) {
  updateResult.textContent = text
  updateResult.className = kind === undefined ? 'muted' : kind
}

/** 渲染引擎版本行（tag 风格同已安装插件版本列），确认有新版本才显示更新按钮。 */
function renderEngineUpdate(info) {
  if (info === null || info === undefined) return
  const installed = info.installed
  const latest = info.latest
  if (installed === null) {
    engineVersionEl.innerHTML = `已安装引擎：<code>未安装</code>　npm 最新：${latest === null ? '（查询失败）' : `v${latest}`}`
  } else if (latest === null) {
    engineVersionEl.innerHTML = `已安装引擎：<code>v${installed}</code>　npm 最新：（查询失败）`
  } else {
    const cmp = compareVersions(latest, installed)
    engineVersionEl.innerHTML = cmp > 0
      ? `已安装引擎：<code>v${installed}</code> <span class="badge stale">可更新 → v${latest}</span>`
      : `已安装引擎：<code>v${installed}</code> <span class="badge latest">最新</span>`
  }
  engineVersionEl.className = 'muted'
  const updatable = isUpdatable(installed, latest)
  if (updatable) {
    engineApplyBtn.hidden = false
    engineApplyBtn.disabled = false
    engineApplyBtn.textContent = `应用引擎更新（v${installed} → v${latest}）`
  } else {
    engineApplyBtn.hidden = true
  }
}

// 初始渲染：取主进程缓存/启动检查结果；主进程完成检查后也会推送刷新。
void api.engineVersion().then(renderEngineUpdate).catch(() => {})
api.onEngineUpdateState((info) => renderEngineUpdate(info))

versionCheckBtn.addEventListener('click', async () => {
  setBtnBusy(versionCheckBtn, true)
  setUpdateResult('正在查询 npm registry 上的引擎最新版本…')
  try {
    const info = await api.engineVersion(true)
    renderEngineUpdate(info)
    if (info.latest === null) {
      setUpdateResult('查询失败：无法访问 npm registry（请检查网络后重试）。', 'err')
    } else if (isUpdatable(info.installed, info.latest)) {
      setUpdateResult(`发现新版本 v${info.latest}（已装 ${info.installed ?? '未装'}）：已显示「应用引擎更新」按钮，建议先「备份 $DSH_HOME」。`, 'warn')
    } else {
      setUpdateResult('已是最新引擎版本。', 'ok')
    }
  } finally {
    setBtnBusy(versionCheckBtn, false)
  }
})

backupBtn.addEventListener('click', async () => {
  setBtnBusy(backupBtn, true)
  setUpdateResult('正在备份 $DSH_HOME…')
  try {
    const path = await api.backupHome()
    setUpdateResult(path === null
      ? '$DSH_HOME 不存在，无需备份。'
      : `备份完成：${path}\n引擎更新出问题时可把该目录内容整体还原（只含数据，不含引擎程序）。`, path === null ? 'muted' : 'ok')
  } finally {
    setBtnBusy(backupBtn, false)
  }
})

engineApplyBtn.addEventListener('click', async () => {
  setBtnBusy(engineApplyBtn, true)
  setUpdateResult('正在重装引擎（npm install，可能耗时数分钟）…')
  try {
    const result = await api.applyUpdate()
    if (result.ok) {
      setUpdateResult('引擎更新完成，已重启。', 'ok')
      void api.engineVersion(true).then(renderEngineUpdate).catch(() => {})
    } else {
      const hint = result.output.includes('neither npm nor pnpm is available on PATH')
        ? '\n（发布版内置 pnpm 垫片。若已是最新版本仍报此错，多为 userData\\runtime-bin 残留旧版垫片：请退出应用后删除该 runtime-bin 目录再重试，应用会自动重建。Windows：%APPDATA%\\dsh-desktop\\runtime-bin；macOS：~/Library/Application Support/dsh-desktop/runtime-bin。若安装路径含中文等非 ASCII 字符——如 Windows 用户名为中文——垫片会因 .cmd 编码问题无法执行，请重装应用到纯英文路径，新版已修复该问题）'
        : ''
      setUpdateResult(`引擎更新失败（exit ${String(result.exitCode)}）：\n${result.output.slice(-1200)}${hint}`, 'err')
    }
  } finally {
    setBtnBusy(engineApplyBtn, false)
  }
})

// ── 应用更新 ────────────────────────────────────────────────────────────────
const appStateEl = document.getElementById('app-update-state')
const appUpdateBtn = document.getElementById('app-update-btn')
const appApplyBtn = document.getElementById('app-apply-btn')
let appCurrentVersion = ''

/**
 * 渲染应用更新状态行：始终显示当前版本说明，「最新 / 可更新」用与已安装插件
 * 版本列相同的 tag。检查与安装是两个独立按钮：
 *  - 「检查更新」任何环境都可用（开发版用纯 HTTP 对比发布源，只报告）；
 *  - 「重启并安装」在确认可更新时才出现；非发布版/未下载完成时保持禁用。
 */
function renderAppUpdate(state) {
  if (state === null || state === undefined) return
  if (state.current !== undefined) appCurrentVersion = state.current
  const packaged = state.packaged === true
  appUpdateBtn.hidden = false
  appUpdateBtn.disabled = false // 开发版也能点「检查更新」

  // 防御：发布源版本不高于当前（如 0.1.6 < 当前 0.1.8）时绝不是“可更新”。
  let aheadNote = ''
  if (state.available === true && state.version !== undefined && compareVersions(state.version, appCurrentVersion) <= 0) {
    aheadNote = `（当前已不低于发布源 v${state.version}，无可用更新）`
    state = { ...state, available: false }
  }

  let html = `当前应用版本：<code>v${appCurrentVersion}</code>`
  if (state.available === null || state.available === undefined) {
    html += packaged
      ? ' <span class="muted">尚未检查…</span>'
      : ' <span class="muted">（开发版）尚未检查——点「检查更新」可对比发布源最新版</span>'
    appStateEl.innerHTML = html
    appStateEl.className = 'muted'
    appApplyBtn.hidden = true
    return
  }
  if (state.available === true) {
    html += ` <span class="badge stale">可更新 → v${state.version}</span>`
    if (!packaged) {
      html += ' <span class="muted">（开发版不能安装，仅提示）</span>'
    } else if (state.downloaded === true) {
      html += ' <span class="ok">已下载完成</span>'
    } else {
      html += ' <span class="muted">（后台下载中…）</span>'
    }
    appStateEl.innerHTML = html
    appStateEl.className = 'muted'
    // 可以更新时更新按钮出现；非发布版或未下载完成前保持禁用。
    appApplyBtn.hidden = false
    appApplyBtn.disabled = !packaged || state.downloaded !== true
    appApplyBtn.textContent = `重启并安装 v${state.version}`
    appApplyBtn.title = !packaged
      ? '开发版不能安装应用更新'
      : state.downloaded === true ? '' : '新版本下载完成后即可安装'
    return
  }
  // available === false：已是最新
  html += ` <span class="badge latest">最新</span>`
  if (aheadNote !== '') html += ` <span class="muted">${aheadNote}</span>`
  else if (!packaged) html += ' <span class="muted">（开发版）</span>'
  appStateEl.innerHTML = html
  appStateEl.className = 'muted'
  appApplyBtn.hidden = true
}

function refreshAppState() {
  void api.appUpdateState().then(renderAppUpdate).catch(() => {})
}
api.onAppUpdateState((state) => renderAppUpdate(state))
refreshAppState()

appUpdateBtn.addEventListener('click', async () => {
  setBtnBusy(appUpdateBtn, true)
  appStateEl.textContent = '正在检查应用更新…'
  appStateEl.className = 'muted'
  try {
    const result = await api.appCheckUpdates()
    if (result.packaged) {
      renderAppUpdate({ current: appCurrentVersion, ...result })
    } else {
      renderAppUpdate(result)
    }
  } finally {
    setBtnBusy(appUpdateBtn, false)
  }
})

appApplyBtn.addEventListener('click', async () => {
  setBtnBusy(appApplyBtn, true)
  appApplyBtn.textContent = '正在重启并安装…'
  try {
    const applied = await api.appApplyUpdate()
    if (!applied) {
      appStateEl.textContent = '尚未完成下载或当前为开发版，无法安装。'
      appStateEl.className = 'err'
    }
    // 成功时应用会退出并重启安装，无需后续 UI。
  } finally {
    setBtnBusy(appApplyBtn, false)
    refreshAppState() // 恢复按钮文字/禁用态
  }
})
