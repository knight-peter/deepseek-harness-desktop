# dsh-desktop Electron 基座应用开发

> 面向接手维护本仓库的开发者——尤其是**从纯前端转来做 Electron 桌面壳**的同学（人与 AI 代理共用）。
> 本文讲「壳」本身：Electron 基础、窗口与进程、引擎托管、打包、更新。dsh 引擎与插件开发见 **[`dsh插件开发.md`](dsh插件开发.md)**；发版流程见 [`发布总结.md`](发布总结.md)；终端用户文档见 [`使用总结.md`](使用总结.md)。
>
> 读完本文你应能回答：这个仓库是怎么运转的、为什么这样设计、改一处代码要跑什么验证、怎么打出一个新包。
>
> **快速上手（首次 5 步）**：`mise install && mise use`（工具链）→ `pnpm install`（壳依赖）→ `pnpm run install-engine`（装引擎，约 7 分钟）→ `pnpm dev`（编译 + 启动）。环境准备与命令详解见 §2.7；从零出包顺序见 §3.1；改完必跑：壳代码 `typecheck` + `lint`，引擎/安装逻辑 `smoke`。

---

## 0. Electron 基础概念速成（前端工程师必读）

如果你只写过浏览器前端，先花十分钟理解下面几个概念——整个仓库的设计都围绕它们展开。

### 0.1 进程模型：主进程 / 渲染进程 / preload

Electron 应用至少有两个 Node.js 运行时：

| 进程 | 是什么 | 类比 |
|---|---|---|
| **主进程（main）** | 启动时运行的 Node 进程，`package.json` 的 `main` 指向它（这里是 `dist/index.js`）。负责生命周期、窗口、菜单、系统能力 | 后端的「服务进程」 |
| **渲染进程（renderer）** | 每个 `BrowserWindow` 加载一个网页，跑的是 Chromium 渲染引擎 | 普通的浏览器标签页 |

主进程和渲染进程**不共享内存**，只能通过 IPC（`ipcMain` / `ipcRenderer`）发消息通信。浏览器页面默认**没有 Node 能力**（`nodeIntegration: false`），它连 `require` 都用不了。

**preload** 是两者之间的桥：一个在渲染进程里、但在页面脚本之前运行的脚本，它通过 `contextBridge` 把主进程能力**白名单式**地暴露给页面（`window.dshDesktop.*`）。本仓库的桥在 `src/preload/preload.cjs`。

### 0.2 contextIsolation 与沙箱（为什么 renderer 没有 Node）

`BrowserWindow` 创建时设了：

```ts
webPreferences: {
  preload: ...,      // 桥脚本
  contextIsolation: true,   // 页面 JS 与 preload 的上下文隔离
  nodeIntegration: false,   // 页面里没有 require/process
  sandbox: true,            // 渲染进程走 Chromium 沙箱
}
```

含义：**页面脚本（哪怕被 XSS 攻破）也拿不到 Node 能力**，只能用 `window.dshDesktop` 上那几个显式暴露的方法。这是安全底线，别改掉。

### 0.3 asar 打包

electron-builder 会把应用代码打进一个 `app.asar` 归档（类似只读的 zip，但 Node 能直接按路径读）。**asar 内是只读的**——所以本仓库有个大坑：打包后 `scripts/install-engine.mjs` 不能靠「自己所在的路径」推导引擎目录（会推导进 asar 里），必须由主进程显式传 `DSH_ENGINE_DIR`（见 §2.6）。所有需要写文件的资源（引擎、preload）都通过 `extraResources` 放到 asar **外**。

### 0.4 ELECTRON_RUN_AS_NODE（Electron 二进制当普通 Node 用）

Electron 的可执行文件本身是个 Node 运行时。设环境变量 `ELECTRON_RUN_AS_NODE=1` 后再跑它，就**退化成纯 Node**（不启动窗口）：

```sh
ELECTRON_RUN_AS_NODE=1 ./dsh-desktop.app/Contents/MacOS/dsh-desktop script.js
```

等于 `node script.js`，但用的是 **Electron 内嵌的那个 Node 版本**（Electron 44 → Node 24.18）。这是本项目的核心技巧：**引擎（上游 `dsh web`）作为子进程跑在 Electron 内嵌 Node 上**，用户机器零依赖——不用装 Node、不用装 pnpm。

### 0.5 electron-builder 与 electron-updater

- **electron-builder**：打包工具，把代码、依赖、图标、产物做成各平台安装包（dmg/nsis/AppImage）。配置在 `electron-builder.yml`（详见 §3.3）。
- **electron-updater**：应用**自身**的自动更新（下载新安装包、重启安装）。它依赖 GitHub Releases / GitCode 镜像上的 `latest*.yml` 元数据。注意它更新的是「壳」，不是引擎——引擎更新是另一条路（§2.6）。

---

## 一、项目总览

### 1.1 项目定位与架构一句话

dsh-desktop 是 DeepSeek Harness（下文简称「上游」，https://github.com/deepseek-ai/deepseek-harness）的 Electron 桌面壳：

- **业务 100% 复用上游** `dsh web` 界面——壳不 fork、不改上游任何代码；
- 引擎（Node 宿主进程）由壳作为**子进程**托管，运行在 **Electron 内嵌 Node** 上（`ELECTRON_RUN_AS_NODE=1`），用户机器零依赖（无需安装 Node / pnpm）；
- 所有用户数据仍在 `$DSH_HOME`（默认 `~/.dsh`），与 `dsh` CLI 完全共享，壳不迁移、不接管（AD-5）；
- 上游持续更新不影响壳：壳只依赖三个稳定触点——`dsh plugin` 命令、引擎 stdout 的 URL 行、profile manifest（见 §2.1 / §2.5），引擎以 npm 发布版锁定安装（AD-3）。

一句话：**壳 = 窗口 + 引擎进程管理 + 插件/调试/更新工具集；引擎 = 上游 `dsh web` 原样。**

### 1.2 技术栈

| 组件 | 选择 | 说明 |
|---|---|---|
| 运行时 | Electron **44.0.0（精确锁定，不能写 `^44`）** | 内嵌 Node 24.18 满足引擎 engines `^22.19 \|\| >=24`（Electron 39 = Node 22 不满足）；**而且必须正好是白名单里那个构建**：引擎 ≥ 0.1.6-alpha.1 的原生 addon 只认精确 V8 指纹，`^44.0.0` 会解析到 44.5.1（V8 15.2.124.28 ≠ 15.2.124.13）照样起不来——详见 §2.1 |
| 语言 | TypeScript（NodeNext ESM，strict） | 只编译 main 进程；preload 用 CJS、renderer 用原生 JS，**均不引框架**（渲染层极薄，刻意不用 electron-vite/React） |
| 打包 | electron-builder 26.x | 三平台：mac dmg+zip / win nsis / linux AppImage |
| 应用更新 | electron-updater | 壳自身更新走 GitHub Releases + GitCode 国内镜像（发布总结.md §4.4）；引擎更新走 install-engine 重装（§2.6） |
| 其他依赖 | js-yaml（patch 校验）、pnpm（内置，供 `dsh plugin` 使用，AD-8） | |

**依赖覆盖与补丁（pnpm-workspace.yaml）**：

- `overrides: { '@electron/get': '5.1.0' }` —— app-builder-lib 26.15.3 引用了只存在于 `@electron/get` ≥ 5 的 `ElectronDownloadCacheMode`，而它声明的 `^3.0.0` 范围会解析到 3.0.0（缺该导出 → 打包时崩溃）。升级 electron-builder 时若上游已修可移除。
- `allowBuilds: electron-winstaller: false` —— 规避不需要的构建脚本。
- `patchedDependencies: { '@electron/osx-sign@1.3.3': patches/... }` —— 把 osx-sign 的 `walkAsync` 改成串行（修 mac 打包 EMFILE，见 发布总结.md §5）。**升级 electron-builder 时重新评估**：上游 [electron/osx-sign#286](https://github.com/electron/osx-sign/pull/286) 未合并前不能去掉。

### 1.3 目录结构与模块职责

```
dsh-desktop/
├─ package.json / pnpm-workspace.yaml / tsconfig.json / eslint.config.mjs
├─ mise.toml                        # 工具版本锁定：Node 24 / pnpm（§2.7）
├─ .env / .env.development / .env.local   # 配置分层：共享 / 开发 / 本机私有（§2.7）
├─ electron-builder.yml             # 打包配置（§3.3）
├─ .github/workflows/build.yml      # CI：三平台矩阵（§2.8）
├─ docs/
│  ├─ Electron基座应用开发.md    # 本文（壳的开发）
│  ├─ dsh插件开发.md             # dsh 插件开发（插件作者）
│  ├─ 使用总结.md                # 使用总结（终端用户）
│  └─ 发布总结.md                # 发版全流程（发布者）
├─ src/
│  ├─ main/                      # Electron main 进程（TS 编译到 dist/）
│  │  ├─ index.ts                # 组装层：生命周期/单实例锁/菜单/窗口/IPC；引擎来源解析；打包态 CLI shim
│  │  ├─ harness.ts              # 引擎子进程管理（§2.1）
│  │  ├─ plugins.ts              # 插件管理后端：包装 dsh plugin 命令 + 脚手架（§2.5）
│  │  ├─ tools.ts                # 调试工具：dump-config / diff / patch 校验写入 / 启动失败诊断
│  │  ├─ config.ts               # settings.json 持久化（原子写）
│  │  ├─ clipboard.ts            # 剪贴板监听（轮询 + IPC 广播）与引擎 UI 剪贴板权限
│  │  ├─ updateSources.ts        # 应用更新源（GitHub + GitCode 镜像）与可达性探测（发布总结.md §4.4）
│  │  ├─ updater.ts              # 引擎版本检查 / $DSH_HOME 备份（electron-free）
│  │  └─ updaterLog.ts           # 更新/退出流程诊断日志：打包态控制台不可见 → 写 userData/updater.log
│  ├─ preload/preload.cjs        # contextBridge：dshDesktop.* API（harness/plugins/tools/settings/updater）
│  └─ renderer/                  # 纯 JS 页面：index.html 状态壳 + manager.html 管理窗口（三页签）
├─ scripts/
│  ├─ copy-static.mjs            # tsc 后把 preload/renderer 拷进 dist/
│  ├─ install-engine.mjs         # 引擎安装/升级（§2.4）——本仓库最关键的脚本
│  ├─ engine-boot-check.mjs      # 引擎 boot/健康检查共享逻辑：install-engine 换装前 gate + smoke（§2.4/§2.8）
│  ├─ prepare-primary-runtime.mjs # Office primary-runtime 载荷准备（§2.11）：锁源下载 + sha256 + 免 pip 解 wheel
│  ├─ smoke-primary-runtime.mjs  # 载荷自检（解释器/五件套/check_office/pip check，§2.11）
│  ├─ smoke-office.mjs           # Office 能力端到端（叠加层组合 + 引擎 boot + 创作/检查/转换全链，§2.11）
│  ├─ primary-runtime.lock.json  # 载荷锁定清单（上游 lock.json 的 verbatim 副本，§2.11）
│  ├─ primary-runtime-smoke.py   # 载荷 Python 自检脚本（上游 smoke.py 的 verbatim 副本，§2.11）
│  ├─ engine-update.mjs          # 引擎一步升级：查最新 → 改 DEFAULT_ENGINE_VERSION（不提交）→ install → rebuild → smoke（§2.4）
│  ├─ rebuild-engine.mjs         # @electron/rebuild 重编引擎原生模块（§2.3）
│  ├─ smoke.mjs                  # 引擎冒烟：boot + 健康检查 + 优雅退出（§2.8）
│  ├─ publish-release.mjs        # 发布 draft 为公开；--with-x64 补发 Intel x64 + 合并（发布总结.md §4.2）
│  ├─ sync-domestic.mjs          # 同步产物到 GitCode latest release（国内更新镜像，发布总结.md §4.4）
│  ├─ download-release.mjs       # 下载 GitHub release 产物：gh CLI 或 GH_TOKEN + curl 回退（镜像前置，发布总结.md §4.2）
│  ├─ bump-version.mjs           # 发布入口：自动累加版本 + commit + tag + push（发布总结.md §4.2）
│  └─ make-self-signed-cert.mjs  # 生成自签名 mac 签名证书并写 .env.local（README「macOS 签名」/发布总结.md §4.5）
├─ patches/                       # pnpm patchedDependencies：osx-sign walkAsync 串行化补丁（§1.2/发布总结.md §5）
├─ test/fixtures/hello-bundle/   # 插件全流程测试 fixture（§2.8 / dsh插件开发.md §5）
├─ resources/                    # 运行期资源：windows-hide.cjs = Windows 隐藏控制台 preload（§2.9）；office.patch.yml = Office 技能叠加层（§2.11）；engine/ 引擎安装区与 runtime/ Office 载荷（均 gitignore）
└─ release/                      # 打包产物（gitignore）：dmg/zip/.app 等
```

**架构分层约定（写新模块前必读）**：`plugins.ts` / `tools.ts` / `config.ts` / `updater.ts` 都是 **electron-free**——不 import electron，路径和可执行文件由调用方注入（`index.ts` 的 `pluginManager()` / `tools()` 组装）。因此它们可以直接用普通 Node 对 dist/ 做单测。新增业务模块请保持这个约定；只有 `index.ts`（和 preload）接触 Electron API。

> 为什么这样分？对前端同学来说，可以理解为「业务逻辑层」与「宿主层」分离：业务模块不知道自己在 Electron 里，单元测试时用普通 Node 就能跑；Electron 的特殊性（窗口、app 生命周期、IPC）全部收敛在 `index.ts`。

### 1.4 架构决策摘要（AD-1 ~ AD-10）

> AD-N = Architecture Decision（架构决策）编号；正文各处 `（AD-N）` 引用均可在下表查到决策与理由，无需去别处找。

| 编号 | 决策 | 理由 / 对应章节 |
|---|---|---|
| AD-1 | 独立仓库，不放进上游仓库 | 上游持续更新，壳与源码彻底解耦 |
| AD-2 | Electron 只做窗口壳；引擎是壳托管的 `dsh web` 子进程（`ELECTRON_RUN_AS_NODE=1`）；BrowserWindow 加载 `http://127.0.0.1:<随机端口>` | 复用原版 UI 零改动、进程隔离（§2.1/§2.2） |
| AD-3 | 发布版引擎用 npm 发布包锁版本装在 `resources/engine`；包缺失时退化为「锁定 commit 构建 + npm pack」 | 开箱即用、升级只换引擎（§2.4） |
| AD-4 | 引擎子进程用 Electron 内嵌 Node 运行；Electron **精确锁定 44.0.0**；原生模块用 `@electron/rebuild` 重编；**引擎换装前必须用真实运行时 boot 校验**（起不来就拒绝升级、保留旧引擎） | 零额外运行时；引擎原生 addon 只认精确 Electron/V8 指纹，故不能写 `^44`，且文件校验挡不住"装得上但起不来"（2026-10-01 事故，§2.1/§2.3/§2.4） |
| AD-5 | 用户数据全部留在 `$DSH_HOME`，壳不迁移、不接管 | 与上游 CLI 共享数据 |
| AD-6 | 插件安装/卸载/更新一律走上游 `dsh plugin` 命令，壳只编排重启 | 上游已实现 pnpm 安装 + bundles reconcile（§2.5） |
| AD-7 | 结构变更（装/卸/更新插件）后自动重启引擎；配置变更走 profile patch HMR 热生效 | 配置 HMR 是配置级的，新行不一定能热挂载；引擎 boot 仅数秒 |
| AD-8 | 发布版附带 pnpm（内置 Node 调用），不要求用户装 pnpm | `dsh plugin` 依赖 PATH 上的 pnpm（§2.5） |
| AD-9 | 单实例锁（`requestSingleInstanceLock`） | 两个壳同时写 `$DSH_HOME` 会冲突 |
| AD-10 | 引擎异常退出（非 0 退出码）不自动重启，弹错误诊断 | 防止崩溃死循环（§2.1） |

### 1.5 安全模型

- 所有 BrowserWindow：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`；renderer 只有 preload 桥出的 `dshDesktop.*` API，无任何 Node 能力（§0.2）。
- 状态壳页面 CSP：`default-src 'self'; style-src 'self' 'unsafe-inline'`。引擎 UI 是引擎自己服务的页面（原样复用上游），不套壳的 CSP。
- 引擎进程由壳 spawn，同用户权限；插件代码在引擎进程内运行（≈ 本机 shell 权限）——文档里始终提示用户只装可信插件。

---

## 二、基座应用开发

### 2.1 引擎子进程托管（harness.ts）

这是壳的核心模块，负责把上游 `dsh web` 作为子进程拉起、确认它真的能服务、并在退出时干净地收尾。

**启动序列**（`harness.start()`）：

1. **找引擎入口** `resolveDshBin()`（index.ts），按优先级：`DSH_ENGINE_BIN` 环境变量 → `resources/engine` 打包引擎 → `DSH_CHECKOUT`（上游源码目录，用其已构建的 `apps/cli/lib/bin.js`）→ 设置里保存的 checkout 路径（仅开发模式生效）。找不到 → 弹错误框提示配置其一。
2. **核对 Node 版本**：`nodeSatisfiesEngine(process.versions.node)` 检查 Electron 内嵌 Node 是否满足引擎要求（`^22.19.0 || >=24.0.0`），不满足直接报错退出。
3. **spawn 子进程**：

   ```ts
   spawn(process.execPath, ['--expose-internals', ..., dshBin, '--profile', 'web', '--port', '0', '--no-open'], {
     env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extra },
     stdio: ['ignore', 'pipe', 'pipe'],
     windowsHide: true,
   })
   ```

   `process.execPath` 是 Electron 二进制，配合 `ELECTRON_RUN_AS_NODE=1` 就是「用 Electron 内嵌 Node 跑引擎」（§0.4）。

4. **等 URL 行**：解析引擎 stdout 里形如 `dsh web: http://127.0.0.1:<port>` 的行拿到**随机端口**（`--port 0`，避免与默认 3080 冲突，多开/占用都不怕）。**`--no-open` 必须带**——不带的话引擎会调用系统打开默认浏览器（实测弹出 `http://127.0.0.1:60829` 之类的多余标签页）；壳自己有窗口，绝不能让引擎开浏览器。smoke.mjs 同样带此参数。
5. **健康检查**：轮询 `fetch(url)`，要求 **HTTP 200 且页面包含 `__DSH_BOOT__`**。为什么必须断言这个标记？因为 dsh 的 web UI 不是独立前端——宿主进程会往 index.html 注入入口图，客户端脚本挂载后页面才算就绪；裸的静态页不代表引擎好了。
6. **状态机广播**：`idle → starting → running / error / stopped` 通过 `onStateChange` 广播给所有窗口；`running` 时主窗口从「状态壳」`loadURL` 到引擎 UI；`error` / `stopped` 时回到状态壳（否则错误会藏在死页面后面看不见）。

**停机**（`harness.stop()`）：关窗/退出 → `SIGTERM` → 等 10s → 还没退就 `SIGKILL`，保证无残留进程。**异常退出（非 0 退出码）绝不自动重启**（AD-10，防崩溃死循环），状态壳展示错误 + 诊断。

**日志**：stdout/stderr 按行缓冲后**双写**（控制台 `[engine:*]` 前缀 + `broadcast('harness:log')` 给所有窗口），同时进 500 行环形缓冲 `recentLogs`——晚开的管理窗口也能回放历史日志。

> **为什么有 `--expose-internals`（2026-08-14 实测）**：Electron 内嵌 Node 下，上游 vendored loader 的原生 internals 钩子（node-addon-require-builtin）会**静默失效**，导致裸插件包名（如 `@deepseek-ai/cordis-plugin-timer`）解析失败、引擎 boot 报 `ERR_MODULE_NOT_FOUND`。加上 `--expose-internals` 后 loader 检测到该 execArg 走纯 `require` 回退路径。**所有跑引擎/CLI 的地方（harness、plugins、tools、smoke）都必须带这个 flag**——漏加的第一个症状就是裸插件名 `ERR_MODULE_NOT_FOUND`。
>
> ⚠️ **2026-10-01 更新：引擎 ≥ 0.1.6-alpha.1 换了 boot 方式，上面那条"回退路径"不再兜底——Electron 版本必须落在上游白名单里。**
> 上游 `packages/boot/app-boot`（commit `6aa2e4633c`，随 **0.1.6-alpha.1** 首发）把 profile 解析拦截改成**无条件**调用 `node-addon-require-builtin`（不再看 `--expose-internals`，旧版 `@deepseek-ai/cordis-plugin-loader` 里那个 `execArgv.includes('--expose-internals')` 分支没了）。而该 addon 的预编译二进制内置一张**精确 V8 指纹白名单**，实测（从 npm 取 0.1.5/0.1.6/0.1.7 三个平台的 `.node` 反查字符串）为：
>
> | Electron | Node / V8 | addon 是否接受 |
> |---|---|---|
> | 43.0.0 | 24.17.0 / 15.0.245.13 | ✅ |
> | **43.4.0（旧壳）** | 24.18.1 / **15.0.245.28** | ❌ 不认 |
> | 44.0.0 | 24.18.1 / 15.2.124.13 | ✅ |
> | 44.5.1 | 24.21.0 / 15.2.124.28 | ❌ 不认 |
> | 45.0.0-alpha.6 | 24.21.0 / 15.4.80 | ✅ |
>
> 症状是引擎 boot 直接退出（应用起不来）：
> `dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context (unsupported Electron runtime fingerprint: Node 24.18.1, V8 15.0.245.28-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))`。
> 已排除的错觉/弯路：① `--expose-internals` 并不能救——实测该 flag 下 5 个 internal 模块都能 `require`，但新 app-boot 根本不走纯 require 回退；② 降级 addon（0.1.5）也不行，它靠动态找 V8 符号，在 43.4.0 上报 `Unsupported/no-realm`；③ 上游自己的桌面端没事只是因为它的 lock 正好锁在 electron `44.0.0` + addon `0.1.6`，是"恰好配对"，不是兼容层。
> **结论**：`package.json` 写死 `"electron": "44.0.0"`（与上游 desktop 锁的版本一致），升级 Electron / 升级引擎后都必须验证引擎能真起（§2.4 的换装前 boot 校验 + §2.8 的 smoke）。

### 2.2 引擎为什么不在 Electron 进程内嵌入

进程内 `boot()` 能拿到 service 级集成，但代价是：Electron 的 Node ABI 与官方 Node 不同（原生模块要重编）、生命周期与进程模型耦合、升级跟着 Electron 重编（对比见 §1.4 AD-2/AD-4）。子进程方案把引擎与壳彻底隔离，升级只换引擎目录。若未来要托盘/菜单直连 service，评估 `@deepseek-ai/dsh-sdk`（stdio JSON-RPC）作为桥，不要直接嵌入。

### 2.3 原生模块与 ABI（rebuild-engine.mjs）

**背景**：Node 原生模块（`.node` 二进制）是按「Node ABI 版本」编译的，而 Electron 内嵌 Node 的 `NODE_MODULE_VERSION` 与官方 Node **不同**——官方 Node 编译的模块在 Electron 里可能加载失败。

**处理**：`rebuild-engine.mjs` 全树扫描 `resources/engine/node_modules` 里的 `.node` 文件：
- 路径含 `prebuilt` 的**跳过**——N-API prebuilds ABI 稳定，跨 Node/Electron 通用，不用重编；
- 其余用 `@electron/rebuild` 按当前 Electron 版本重编。

**升级 Electron 大版本后必须重跑 `install-engine` + `rebuild-engine` + `smoke`，并跑一遍 `typecheck`（API/类型破坏会在这里现形）。** 打包态（`updater:apply`）找不到 `electron-rebuild`（它是 devDependency，不随包发布）时，rebuild-engine 会打印说明并以 0 退出——registry 引擎的 N-API prebuilds 跨 ABI 稳定，可以安全跳过重编。**注意 Electron 版本必须精确**（见 §2.1 的白名单表）。另外 `pnpm install` **不会**下载 Electron 二进制：`node_modules/electron` 的 npm 包既没有 `postinstall` 也不带 `dist/`，而是第一次 `require('electron')` 时惰性调用 `install.js` 补齐（`pnpm dev` / `pnpm run smoke` / install-engine 的 boot 校验都会触发；打印 `Downloading Electron binary...`）。所以这些命令要走 `pnpm run …`（脚本会加载 `.env.local` 里的 `ELECTRON_MIRROR`，§3.5），或手动 `node node_modules/electron/install.js`。

> **43 → 44 的 API 破坏（2026-10-01 实测）**：Electron 44 把主进程 `clipboard` 改成**异步**（对齐 W3C：`readText(): Promise<string>`、`writeText(): Promise<void>`、`has()`、`read()`/`write()` 全是 Promise，没有 sync 变体）。旧的同步写法不会报错，只会静默坏掉——`ClipboardWatcher` 会把 Promise 当字符串比较，剪贴板变化永远不上报。本次已改：`clipboard.ts` 的轮询改 async + 首读建立基线（原来在 `start()` 里同步建基线）、`index.ts` 的「粘贴到焦点窗口」`await clipboard.readText()`、「复制链接地址」`void clipboard.writeText(...)`、IPC `clipboard:read-text` 直接返回 Promise（`ipcMain.handle` 原生支持）。**升级 Electron 时重点复查 `clipboard.*` 调用点**（`grep -rn "clipboard\." src/`）。

### 2.4 引擎安装与升级（install-engine.mjs）

**这是本仓库最关键的脚本**。它把锁定版本的引擎装到 `resources/engine`：

- **锁定版本**：文件顶部 `DEFAULT_ENGINE_VERSION` 常量（当前 `@deepseek-ai/dsh@0.2.0-rc.2`，与 npm `latest` 对齐）。**只有 `dsh` 一个版本轴**——web 前端通过 `dsh → dsh-web-app → dsh-web-frontend` 传递解析，别单独钉（单独钉会装出一棵用不到的副本，还把引擎拖到依赖方不共享的版本轴上）。**升级引擎 = 改它后重跑脚本**（本地一条命令：`pnpm run engine-update`，见下）。**这个常量必须是"能在这台壳的 Electron 上真起得来"的版本**：换装前 boot 校验（见下）会在 CI 拦住起不来的；同时它也必须是**新近发布**的版本——旧版本今天重装会按今天的 registry 解析依赖范围，2026-10-01 的两次事故正是这么来的：`0.1.5-rc.1` 把自己的子包浮动成 `0.1.5-rc.3`（版本错位树），而 `0.1.1-rc.2`（2026-09-10 还能跑通 smoke）今天已经根本起不来。
- **安装路径**：主路径 npm registry；失败（断网/包缺失）时若有 `DSH_CHECKOUT` 环境变量，走兜底——在 checkout 里 `pnpm install && pnpm build`，对 `apps/cli`、`apps/web` `pnpm pack` 成 tarball 后安装（pnpm pack 会把 workspace: 依赖改写为具体版本）。**包管理器 pnpm 优先、npm 兜底**（2026-08-20 实测：npm 11 在代理/慢 registry 上解析 547 个依赖会长时间无输出地挂起——连接指向 fake-ip 网段 198.18.0.0/15 的代理时尤为明显；pnpm 并发下载 + 快速重试 + store 缓存，同一引擎约 30s 装完）。pnpm 分支会在安装目录写一个空 `pnpm-workspace.yaml`，避免 pnpm 向上找到本仓库的 workspace 配置后把引擎目录当 workspace 成员而空转；并传 `npm_config_strict_dep_builds=false`（pnpm 11 默认 strict=true 会因忽略构建脚本硬失败）。
- **原子换装 + 换装前 boot 校验**：已存在引擎时先装进 `resources/engine.new` → 静态校验（dsh bin + 前端 dist/index.html 存在）→ **用真实运行时 boot 一次并确认它真的在服务**（URL 行 → `GET /` 拿到 `__DSH_BOOT__` 页面 → 再静置 3s 仍存活）→ 才 rename 换入（旧引擎先改名 `.old`，换入失败自动回滚）→ 删除 `.old`。**任何一步失败都不破坏旧引擎**（staging 目录直接丢弃）。boot 校验用临时 `$DSH_HOME`（不碰用户数据），跑的是 `scripts/engine-boot-check.mjs`——与 `smoke.mjs` 共用同一套 spawn/健康检查逻辑。
  - 为什么必须"真 boot"而不只是查文件：上游引擎可以在 npm 上装得下来、却在壳的 Electron 上起不来（2026-10-01 指纹事故），或者**装出来是一棵版本错位的树**（见下）——两种情况都是"装好了、启动即死"，静态校验一个都挡不住。
  - 为什么还要"静置 3s"：错位树会**先绑端口、先打印 URL**，然后在 profile 收尾阶段才崩（`user patch-layer watching requires the Cordis HMR service`）。只等 URL 会误判为通过。
- **版本错位陷阱（2026-10-01 实测）**：`@deepseek-ai/dsh` 用 **caret 范围**声明自己的子包（`^0.1.5-rc.1`），而 npm 的预发布匹配规则只允许同一 `[major,minor,patch]` 的预发布版本，所以**装一个不是该元组最新预发布的版本，会把所有子包浮动到最新的同元组版本**：装 `dsh@0.1.5-rc.1` 实际得到 `dsh@0.1.5-rc.1` + `@deepseek-ai/dsh-app-boot@0.1.5-rc.3` + …（今天 rc.3 是最新）。这棵树能装、能起、能打印 URL，但会在 profile 收尾时崩。所以：**要装某个版本线就装它最新的预发布**（0.1.5 线 → `0.1.5-rc.3`），脚本会在装完后检查 `@deepseek-ai/dsh-*` 与 `dsh` 的版本一致性，漂移时打 WARNING 并把清单附在 boot 失败的诊断里（`engineVersionDrift()`，导出函数可直接测试）。
- **prebuilds 剪枝**（`pruneForeignPrebuilds`，导出函数可直接测试）：删除 node_modules 里非当前平台的 `prebuilds/<platform>-<arch>/` 目录——node-pty 一家就省 ~58MB win32 二进制（引擎 352M → 294M）。保守策略：只有 `prebuilds/` 根内含当前平台目录时才剪，根级文件不碰。**多架构打包时设 `DSH_KEEP_ALL_PREBUILDS=1` 跳过剪枝**（CI mac 打包 x64+arm64 双架构：runner 是 arm64，若剪枝会剪掉 darwin-x64 的 prebuilds，打出的 Intel 包引擎原生模块缺失）。
- 安装结果写 `resources/engine/engine.json`（时间、来源、版本），排查「升级没生效」先看它。
- **一步升级（engine-update.mjs，仅本地）**：`pnpm run engine-update` = 默认查 npm latest（只有 `@deepseek-ai/dsh` 一个版本轴；前端包跟随传递解析）→ 改写 `DEFAULT_ENGINE_VERSION`（**不提交**，留在工作区待 review，`git diff scripts/install-engine.mjs`）→ `install-engine` → `rebuild-engine` → `smoke`。参数：`--no-bump` 跳过改 DEFAULT_ENGINE_VERSION、仅按当前版本重装（修复用）；`--version X` 显式钉 `@deepseek-ai/dsh` 版本；`--dry-run` 只打印将改什么；`--no-smoke` 跳过冒烟。**CI 与打包应用不经过它**：CI 直接跑 install-engine/rebuild-engine/smoke 构建提交的 DEFAULT_ENGINE_VERSION，打包应用的 `updater:apply` 复用同一组脚本且绝不改动 asar 内 DEFAULT_ENGINE_VERSION。
- 引擎目录在 `.gitignore`（构建期产物），本地和 CI 都先跑 install-engine 再打包（§3.1）。

### 2.5 插件管理管线（plugins.ts，壳侧）

壳**不实现**插件机制（加载/注册/分层/reconcile/HMR 全是上游 Cordis 插件树的事），只做「调命令、捕获输出、编排重启」（AD-6/AD-7）——这是项目成立的根基，别在壳里复制机制。

**管线**：管理窗口面板操作 → IPC（`plugins:*`）→ `PluginManager` → 流式 spawn `node --expose-internals dshBin plugin --profile web add|remove|update`（chunk 实时转发给管理窗口，300s 超时强杀）→ 成功则自动重启引擎。插件的**写法**见《dsh插件开发.md》。

**M1/M2 改进（2026-09-03 新增）**：插件管线从「spawnSync + 尾部输出」升级为「流式 + 分类 + 可处置」——

- **三态分类**（`analyzePluginOutput`，plugins.ts）：把 `dsh plugin` 结果归为可处置的 typed issue —— `build-approval`（pnpm ≥10/11 拦依赖构建脚本，如 node-pty）、`git-prepare`（git 插件 prepare 脚本被拦，上游会打 allowBuilds 提示）、`pnpm-missing`、`registry`（404/ETARGET）、`network`。pnpm 10 非 strict 默认下 `add` 会成功但跳过脚本 → 归类为 warning（`warningPackages`），照常装完但提示「放行并重建」。
- **放行并重装**（IPC `plugins:approve-install`）：UI 按钮 → `PluginManager.approveBuilds()` 把 `allowBuilds: { <pkg>: true }` 合并进 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`（js-yaml 读写；该 map 格式 pnpm 10.34.5 与 11 通用，等价官方 `pnpm approve-builds` 的产物）→ 在 profile 目录跑 `pnpm install`（让新放行的脚本真正执行）→ 重跑原 `add`（触发 bundles reconcile）→ 重启引擎。开发者/官方 CLI 的「approve-builds 三步」在界面里缩成一次点击。
- **安装结果摘要**（M2）：install 前后 diff profile manifest（`snapshot()`），对新装包读其 package.json 的 `dsh` 字段分类（bundle 分层 / 客户端 `dsh.client` / 纯普通依赖），界面提示「已加入 bundle 分层」或「未声明 dsh.bundle，只是普通依赖不会挂载」；`list()` 行类型徽标同步扩展（bundle / 客户端 / 依赖 / 模板）。
- **检查更新**（IPC `plugins:check-updates`）：对每个 registry 依赖（跳过 `file:`/`link:` 与模板层）查 `registry.npmjs.org` 的 `dist-tags.latest`，界面标「可更新」并提供「全部更新」（即 `dsh plugin update` 不带包名）。
- **启动自动版本检查（2026-09-04 新增）**：应用启动 4s 后跑一次 registry 检查（`runPluginVersionCheck`：单飞 + 结果缓存 `pluginUpdateCache`；`plugins:startup-updates` 返回缓存、无缓存时惰性补跑一次后台检查；检查完成后以 `plugins:updates` 推送给已打开的管理窗口）。渲染层对所有能查到最新版的 registry 依赖行做三态呈现：版本列标「最新」（最新版 ≤ 已装）或「可更新 → x.y.z」（**最新版 > 已装，`compareVersions` semver 比较、预发布感知**——`0.1.8` 已装对发布源 `0.1.6` 不算更新），**更新按钮只在确有可更新版本时出现**；本地目录 / git / 离线查询不到的只显示版本、无更新按钮。registry 检查会跳过 git spec（`git+…`/`.git`），避免误查。
- **UI 布局与操作反馈（2026-09-04）**：作用于**全部已装插件**的操作（刷新 / 检查更新 / 全部更新）移到插件表格**标题栏右侧**，与下方「安装单个插件」的输入行分开，避免把整表操作误读为某个安装动作；「全部更新」按钮实时显示数量（无更新时叫「全部更新」，有 n 个可更新时叫「全部更新（n）」）。操作结果一律改为**窗口顶部居中的穿透式 toast 轻提示**（同时只显示一条，新提示替换旧提示；半透明 + `pointer-events:none`，即使浮在按钮上方也不挡点击/视线；ok/info 约 3s、warn/err 约 5–6s 自动淡出；进行中为带转圈动画的 busy 条，结束后被结果替换）；多行细节输出（安装摘要、pnpm 报错尾部）保留在页面底部「操作日志」（`#action-log`），插件页内不再有常驻状态行（`#plugin-status` 移除）。
- 失败不再静默：所有 mutation 的 pnpm/引擎输出在管理窗口实时显示，错误按 issue 类型给「放行并重装 / 打开 profile 目录」等处置按钮。

**打包态怎么跑 pnpm**（AD-8，`runtimeBinEnv`/`cliCommandEnv`）：用户机器可能没有 Node/pnpm，且 **GUI 启动的进程 PATH 是最小集**（`/usr/bin:/bin:…`，不含用户 shell 的 mise/nvm 路径——这就是「应用引擎更新」报 `neither npm nor pnpm is available on PATH` 的根因）。壳在 userData 下建 `runtime-bin/`：

- `node` 符号链接 → Electron 二进制（配 `ELECTRON_RUN_AS_NODE=1` 就是 Node）；
- `pnpm` 启动脚本 → `exec <Electron二进制> <asar 内 pnpm.cjs> "$@"`（Windows 写 `pnpm.cmd`）。

PATH 前置 runtime-bin 后，`dsh plugin` 和 `updater:apply` 的 install-engine 都能无系统依赖执行。shim 写失败是非致命的（有系统 pnpm 时照常跑）。

> ⚠️ **跨版本残留坑（v0.1.0–v0.1.2 → v0.1.3+）**：旧版 `cliCommandEnv()` 没有平台分支，在 Windows 上也向 `runtime-bin/` 写了一个**无扩展名的 POSIX `pnpm` 文件**（cmd.exe 无法执行）。v0.1.3 曾以 `existsSync(runtime-bin/pnpm)` 作为创建判定，导致 `pnpm.cmd` 永远不生成 → 升级后「应用引擎更新」仍报 `neither npm nor pnpm is available on PATH`。修复：`runtimeBinEnv()` 改为**每次启动重建垫片**（win32 用 `pnpm.cmd` 判定并先清理旧的无扩展名 `pnpm`），自愈。若用户从旧版升级后仍报此错：退出应用，删除 `runtime-bin/` 目录（Windows `%APPDATA%\dsh-desktop\runtime-bin`；macOS `~/Library/Application Support/dsh-desktop/runtime-bin`）再重开即可。

> ⚠️ **非 ASCII 安装路径坑（v0.1.5 及以前）**：`pnpm.cmd` 由 `writeFileSync` 以 **UTF-8** 写入，而 cmd.exe 按系统 ANSI 代码页（中文系统 = GBK）解析 .cmd——若应用装在含中文等非 ASCII 字符的路径（典型：Windows 用户名为中文，NSIS per-user 装到 `%LOCALAPPDATA%\Programs\dsh-desktop`），垫片内嵌的 exe/asar 路径被错误解码（如 `刘源` → `鍒樻簮`）→ 执行报「系统找不到指定的路径」→ 引擎更新仍报 `neither npm nor pnpm is available on PATH`。**删除 runtime-bin 无济于事**（自愈重写后还是 UTF-8 照样坏）。修复（v0.1.6+）：win32 垫片改为 **UTF-16LE + BOM** 写入（cmd 原生按 Unicode 解析，路径原样保留）。存量用户临时解法：重装应用到纯 ASCII 路径（如 per-machine 装到 `C:\Program Files\dsh-desktop`）。

**list()**：读 profile manifest（`$DSH_HOME/profiles/web/package.json` 的 dependencies + `dsh.profile.bundles`）展示已装插件；`TEMPLATE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']` 是 web profile 模板自带层，标记 template 不可卸载。

**scaffold(name)**：生成模板到 `$DSH_HOME/plugins-local/<name>/`（package.json 声明 `dsh.bundle` patch 层 + `lib/index.js` 函数插件 + `cordis.patch.yml`），随后自动 `file:` 安装（模板逐行讲解见 dsh插件开发.md §3）。

### 2.6 设置与更新

**设置持久化（config.ts）**：`<userData>/settings.json`，原子写（tmp + rename）。字段：

| 字段 | 作用 |
|---|---|
| `checkoutPath` | 开发模式引擎来源（上游源码目录） |
| `inspectPort` | 给引擎加 `NODE_OPTIONS=--inspect=<port>`，Chrome DevTools attach（高级断点） |
| `updateSource` | 应用更新源：auto（GitCode 优先 + GitHub 兜底）/ 固定 github / 固定 gitcode |

> 2026-09-04：`autoCheckUpdates` 设置项已移除——发布版**启动即自动检查**应用更新，管理窗口「应用更新」区通过 `app:update-state`/`plugins:` 式推送显示状态，确认新版本下载完成才显示「重启并安装」按钮；引擎更新同理（`refreshEngineVersionInfo` 5 分钟缓存 + `updater:engine-state` 推送），`updater:engine-version` 增加 `force` 参数绕过缓存。

**引擎更新相关（updater.ts）**：`latestEngineVersion()` 查 npm registry；`installedEngineVersion()` 读引擎包版本；`backupDshHome()` 把 `$DSH_HOME` 复制成 `$DSH_HOME-backup-<时间戳>`。

**`updater:apply`（IPC，引擎重装）**：spawn `install-engine.mjs` → `rebuild-engine.mjs`（各 600s 超时）→ 重启引擎，返回 `{ok, output, exitCode}`（渲染层据此显示真实退出码）。三个关键点（都是踩坑后的修复）：

1. **env 用 `runtimeBinEnv()`**：打包态 PATH 前置 runtime-bin，否则必然报 `neither npm nor pnpm is available on PATH`——GUI 启动的进程 PATH 不含用户 shell 的 pnpm/npm；
2. **打包态传 `DSH_ENGINE_DIR=<process.resourcesPath>/engine`**：scripts/ 在只读 asar 内，默认推导出的引擎目录是 asar 内路径，写入必失败；
3. **`rebuild-engine.mjs` 缺 `electron-rebuild` 时优雅退出 0**：devDependency 不随包发布；registry 引擎的 N-API prebuilds 跨 ABI 稳定。

**升级前先备份 `$DSH_HOME`**（管理窗口的「备份」按钮）——上游预发布期 `SESSION_FORMAT_VERSION=0`，数据格式不承诺兼容。

**两类更新（注意区分）**：

| 类型 | 更新什么 | 机制 |
|---|---|---|
| **引擎更新** | 重装 `resources/engine`（走 npm registry） | `updater:apply`（上文） |
| **应用更新** | 换壳本身（新安装包） | electron-updater，双更新源：GitHub Releases（默认）+ GitCode 国内镜像 |

**自动更新体验（`setupAutoUpdater()` + `checkUpdatesWithFallback()`）**：更新源由 `updateSources.ts` 决定。行为：启动检查**静默**（不弹窗打扰）；发现新版后台自动下载（`autoDownload=true`）；下载完成弹「立即重启 / 稍后」——立即重启走 `app.quit()`（`before-quit` 先停引擎再放行，`autoInstallOnAppQuit` 安装），稍后则在下次退出时自动装。手动「检查应用更新」有进度 HUD + 结果弹窗（发现新版本 / 已是最新 / 失败可重试 / 超时）。⚠️ 事件监听必须在 `boot()` 里注册一次（`setupAutoUpdater()`），且仅 `app.isPackaged` 时生效（dev 模式无更新源）。

### 2.7 本地开发工作流

**环境准备**：

- **mise 管理工具版本**（`mise.toml`）：Node 锁 24.x（与 Electron 44 内嵌 Node 24.18 一致，满足 engines `>=22.19`，且保证 `node --env-file-if-exists`（≥22.9）可用）、pnpm 锁 10/11（与 CI 一致）。新环境：`mise install` 安装锁定版本，`mise use` 信任配置。
- 网络：GitHub 直连不稳时用 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` 下载 Electron 二进制（本机已配 `.env.local`，见 §3.5）。

**配置分层（`.env` / `.env.development` / `.env.local`）**：需要凭据的脚本（build / publish-release / install-engine 等）通过 Node 原生 `--env-file-if-exists` **按序加载三层**（后覆盖前）：`.env`（配置总览，提交：共享真实值 `GH_OWNER`/`GH_REPO` + 底部附本机私有项注释模板）→ `.env.development`（开发覆盖，提交，如 `DSH_CHECKOUT` 约定路径）→ `.env.local`（本机私有，gitignore，token/证书/Apple ID），**无需每次 export**。`.env.local` 创建：复制 `.env` 底部「本机私有配置」注释段到 `.env.local` 取消注释填值（⚠️ 私有值绝不填进 `.env`，会随提交泄漏）。CI 无这些文件，`--env-file-if-exists` 静默跳过，继续用 secrets。已 export 的环境变量优先于文件值。**`pnpm dev` 刻意不读 env 文件**——日常启动零配置依赖（clone 下来直接能跑），否则残留配置（如过期的 `DSH_ENGINE_BIN`）会导致启动失败且难以排查。**仓库归属类变量（GitHub owner/repo）不硬编码在代码里**：`electron-builder.yml` 的 publish 用 `${env.GH_OWNER}`/`${env.GH_REPO}` 宏读取，统一由 `.env` 提供。

**常用命令**：

| 命令 | 作用 | 何时跑 |
|---|---|---|
| `pnpm install` | 装壳依赖 | 首次 / 改依赖 |
| `pnpm run engine-update` | 一条命令升级引擎：查最新 → 改 `DEFAULT_ENGINE_VERSION`（不提交）→ install → rebuild → smoke（`--no-bump` 仅重装、`--version X` 显式版本、`--dry-run` 预览、`--no-smoke` 跳过冒烟） | 升级引擎版本（本地，§2.4） |
| `pnpm run install-engine` | 装锁定版本引擎到 resources/engine（registry 主路径，首次约 7 分钟） | 首次、升级引擎、CI |
| `pnpm run prepare-primary-runtime` | 组装 Office 载荷到 resources/runtime（sha256 锁定下载，§2.11；镜像见该节） | 首次、升级引擎后、CI |
| `pnpm run smoke-primary-runtime` | 载荷自检（解释器 + 五件套 + check_office + pip check） | 动过载荷/lock 后 |
| `pnpm run smoke-office` | Office 能力端到端（叠加层 + boot + 创作/检查/转换） | 动过 office 接线后 |
| `pnpm run rebuild-engine` | 重编引擎原生模块 | 换 Electron 版本后 |
| `pnpm run smoke` | 引擎冒烟（Electron-as-Node boot + 健康检查 + 优雅退出） | 动过引擎/安装逻辑后 |
| `pnpm dev` | compile + 启动壳（状态壳 → 自动加载引擎 UI） | 日常开发 |
| `pnpm run compile` | 只编译：tsc 编译 main + 拷 preload/renderer 到 dist/ | 只改 main/preload/renderer，不打包 |
| `pnpm run typecheck` / `pnpm run lint` | 静态检查 | 提交前 |
| `pnpm build` | compile + electron-builder 出**当前平台、当前架构**产物到 release/（本机 Intel Mac → x64 dmg/zip） | 打本地自测包（§3） |
| `pnpm run release` / `publish-release` / `sync-domestic` | 发布相关 | 发新版（发布总结.md） |

**`compile` 是什么**：只做「把源码变成 `dist/` 运行产物」，**不打包**。具体两步——① `tsc -p tsconfig.json`：把 `src/main/*.ts` 编译成 ESM 输出到 `dist/`（`main` 字段指向 `dist/index.js`）；② `node scripts/copy-static.mjs`：把 `src/preload/preload.cjs`、`src/renderer/*` 原样拷进 `dist/`（这俩不经过 tsc，CJS/原生 JS 直拷）。`dist/` 既是 `electron .` 的运行入口，也是 electron-free 模块单测的对象。**何时用**：改了 main/preload/renderer 只想快速起壳手测（`pnpm dev` 内部已含 compile）或单独刷新 `dist/`；不需要它时别单独跑——`pnpm build` 会先 compile 再打包，一步到位。

**环境坑速查（都踩过）**：

- pnpm 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 或 `ERR_PNPM_OUTDATED_LOCKFILE` → `CI=true pnpm install --no-frozen-lockfile`。
- 启动秒退、无任何日志（exit 0）→ 单实例锁被残留实例占着：`pkill -f dsh-desktop` 后重试。
- 引擎 boot 报裸插件包名 `ERR_MODULE_NOT_FOUND` → `--expose-internals` 漏加（§2.1）。
- 引擎 boot 报 `node-addon-require-builtin unsupported: Unsupported/no-context ... unsupported Electron runtime fingerprint` → 壳的 Electron 不在上游白名单里（§2.1）：引擎 ≥ 0.1.6-alpha.1 只认 Electron 43.0.0 / 44.0.0 / 45.0.0-alpha.6。修复：`"electron": "44.0.0"`（精确）后重装引擎；`install-engine` 的换装前 boot 校验会先拒绝这种引擎，不会再把能用的引擎换坏。
- 引擎打印了 `dsh web: http://127.0.0.1:<port>` 却立刻退出（`user patch-layer watching requires the Cordis HMR service`）→ 引擎树**版本错位**（§2.4）：`dsh@x.y.z-rc.a` 配 `@deepseek-ai/dsh-*@x.y.z-rc.b`。修复：装该版本线**最新的预发布**（如 0.1.5 线用 `DSH_ENGINE_VERSION=0.1.5-rc.3`）。
- `electron .` 无窗口无日志 → 检查是否有第二个实例/开发目录路径。
- 打包崩溃 `Cannot read properties of undefined (reading 'ReadWrite')` → `@electron/get` 覆盖被移除（§1.2）。
- 打包/`pnpm list` 报 `ERR_SQLITE_ERROR: unable to open database file`（electron-builder 的 node-module-collector 阶段失败）→ **pnpm 全局 store 的 `index.db` 损坏**（本机 `~/Library/pnpm/store/v11/index.db`，异常中断写坏）。修复：备份该文件（`mv index.db index.db.bak`）后 pnpm 自动重建索引（2026-08-17 实测）。**注意**：这不是 electron-builder 的 bug，是 pnpm 环境问题；`pnpm list --depth 0` 可快速复现判断。

### 2.8 测试与验证

**smoke.mjs**：按壳完全相同的参数（`--expose-internals` + `--profile web --port 0` + `--no-open` + `ELECTRON_RUN_AS_NODE=1`）boot 引擎，断言：URL 行 60s 内出现 → `GET /` 跟完 0.1.5 的 token 303 拿到 HTTP 200 + `__DSH_BOOT__` → SIGTERM 后 10s 内干净退出（code 0 或 signal SIGTERM）。**任何引擎相关改动后跑它。** spawn/URL/健康检查都在 `scripts/engine-boot-check.mjs`（与 install-engine 的换装前 gate 共用；flag 漏加/参数写错只需改一处）。`DSH_ELECTRON_BIN` 指定运行时（默认：打包态=自己的 Electron 二进制；dev/CI=工作区 `electron` devDependency），`DSH_ENGINE_BIN` 指定引擎入口。**失败必带引擎 stderr 尾部**，不再只报"fetch failed"。

**插件全流程（test/fixtures/hello-bundle）**：验证「壳的插件管线没被上游机制变化打破」的最小回归：`dsh plugin --profile web add file:<fixture 绝对路径>` → profile manifest 的 bundles 自动 reconcile（`[dsh-base, dsh-web-app, dsh-hello-bundle]`）→ 重启引擎 → 日志出现 `[hello-bundle] mounted` → `remove` 后 bundles 恢复原状（2026-08-16 实测通过）。fixture 结构即最小 bundle 插件范例（见 dsh插件开发.md §3）。

**CI（.github/workflows/build.yml）**：**CI 只在打 `v*` tag 时触发**（`on.push.tags`，普通 push 不跑）；`workflow_dispatch` 可手动触发。三平台矩阵（macos-15 / windows / ubuntu），每台机器上按序执行：lint → typecheck → install-engine → rebuild-engine → compile → smoke → build（打包）→ 上传 `release/*` 产物（`if-no-files-found: error`）。**正式发布物由 CI 出**；本机 `pnpm build` 仅自测当前平台。tag 推送时 Package 步骤传 `--publish onTagOrDraft`（自动建 release），普通触发传 `--publish never`。mac runner 固定 `macos-15`（arm64，Apple Silicon）——不用 `macos-latest` 是防标签漂移（GitHub 已无 Intel macOS runner，macos-13 退役）。mac 签名凭据在 Package 步骤透传：路线一自签名证书走 `DSH_MAC_CSC_LINK`（p12 base64）/`DSH_MAC_CSC_KEY_PASSWORD` secret——mac runner **先信任证书再构建**（`security add-trusted-cert`，否则 `find-identity -v` 过滤掉未信任身份 → 0 valid identities），兼容旧 `CSC_LINK`；未配置时回退 ad-hoc 签名（打包不失败）。Apple 公证凭据（`APPLE_ID` 等）同样只放 GitHub secrets，不进仓库。mac 的 Package 步骤还会 `sudo sysctl` 抬高 `kern.maxfilesperproc` + `ulimit`，配合 osx-sign 补丁解决 EMFILE（发布总结.md §5）。Intel x64 包由本机构建后用 `publish-release --with-x64` 合并进同一 release。⚠️ 镜像同步**不在 CI 做**（GitHub runner → 华为云 OBS 上传实测不通），由本机 `sync-domestic` 维护。

**改了什么跑什么（检查清单）**：

| 改动 | 必跑 |
|---|---|
| main 逻辑（harness/plugins/tools/config/updater） | `typecheck` + `lint` + `dev` 手测 |
| 引擎安装/升级逻辑、`DEFAULT_ENGINE_VERSION` 版本 | `engine-update`（或 `install-engine` + `smoke`；再打包产物实机 boot） |
| 打包配置（electron-builder.yml） | `build` + 打开产物验证（`.app` 直跑：`release/mac/dsh-desktop.app/Contents/MacOS/dsh-desktop`） |
| preload / renderer | `compile` 后 `dev` 手测两个窗口 |
| 插件机制相关 | 插件全流程 fixture（§2.8 / dsh插件开发.md §5） |

### 2.9 Windows 后台执行与隐藏控制台（resources/windows-hide.cjs）

**问题**：打包版在 Windows 上弹 cmd 窗口执行命令——对话时 agent 跑 shell 命令、插件安装/卸载/更新、应用内引擎更新/重装都会触发，有时执行完窗口还不关；终端里跑 `dsh web` 无此问题。

**根因**：Windows 规则——控制台程序（`cmd.exe`/`node.exe`/`npm`/`pnpm` 的 `.cmd` shim）从**没有控制台的父进程**启动时，Windows 会为它**新建并显示**一个控制台窗口；从有控制台的父进程（终端）启动则挂到同一终端。打包版 `electron.exe` 是 GUI 子系统进程、没有控制台，而 Node `child_process` 的 `windowsHide` 默认 `false` → 引擎/壳 spawn 的每个控制台子进程都弹窗。「执行完不关」：窗口生命周期 = 最后一个挂在该控制台上的进程退出，pnpm/npm 拉起的 `node.exe` 子进程（install/prepare/postinstall 脚本）若存活，窗口就残留。

**修复（两机制，引擎为第三方仓库、零改动）**：

- **机制 A**——壳自己的 spawn/spawnSync 直接加 `windowsHide: true`（= CreateProcess `CREATE_NO_WINDOW`）：`harness.ts`、`tools.ts`、`plugins.ts`、`index.ts`（updater:apply）、`scripts/install-engine.mjs`（`pmSpawn`）、`scripts/rebuild-engine.mjs`。覆盖引擎更新/重装等桌面侧路径。
- **机制 B**——引擎内部 spawn（对话时 agent 命令走 `dsh-subprocess-local` 的 `spawn()`、插件管理走 `dsh plugin` 的 pnpm `spawnSync`）壳够不着：注入 win32-only preload `resources/windows-hide.cjs`，经 `--require` 加载进引擎进程（`engineNodeArgs()` 拼 `--require <absPath>`，仅 win32、文件缺失时返回空；打包态经 extraResources 放真实路径、避开 asar），包装 `child_process.spawn`/`spawnSync` 强制 `windowsHide: true`。exec/execFile/execSync/execFileSync 内部都委托这两个，无需逐个包装。**注意 ESM 具名导入是导入时快照**——`--require` 先于引擎模块加载才生效（本仓库顺序恰好如此，已实测）。
- **`shell: true` 不能去掉**：Windows 上 `.cmd`/`.bat` shim 在 CVE-2024-27980 之后必须走 shell（Node 拒绝直接执行）。`windowsHide` 与 `shell` 不冲突，只是隐藏控制台窗口，命令照常在后台跑、输出照常进管道/界面。

**要点**：

- `windowsHide` 只隐藏窗口，**不消灭进程**：npm/pnpm 残留子进程仍存在（不可见），极端情况仍占资源。
- 已知边角：`windowsHide` + `stdio: 'inherit'` 有上游 issue（nodejs/node#17824），Windows 实机验收重点确认 pnpm/命令输出仍被正常捕获。
- 本机（mac）已验证：preload 的 win32 分支可用 `Object.defineProperty(process, 'platform', { value: 'win32' })` 模拟 + 包装原函数断言；ESM 互操作、参数形态（含 `spawn(cmd, undefined, opts)` 边界）、幂等、darwin 无操作均已实测。Windows 打包版实机验收待 Windows 上执行。

### 2.11 Office 能力（LibreOffice 转换 + Python office 技能）

产物里有两条独立的 Office 能力线（实施方案：docs/plans/2026-10-01-Office转换与Python运行时实施方案.md；spike 结论同文件 §七）：

| 线 | 组成 | 状态 |
|---|---|---|
| **Office → PDF/PNG**（LibreOffice） | 引擎 web profile 自带 `office-to-pdf` 插件 + npm 平台包 `@deepseek-ai/libreoffice-kit-<platform>`（约 150 MB 原生引擎随包；Linux 走 `-wasm`） | 随引擎 0.2.0-rc.2 自动获得，无需配置 |
| **Office 创作与结构检查**（Python） | **primary-runtime 载荷**（CPython 3.12.14 + 13 个锁定 wheel）+ `resources/office.patch.yml` 叠加层挂 `workspace-dependencies` + `skill-office` | 由本仓库构建/接线（本节） |

**载荷布局**（与上游 deepseek-harness 同构，`skill-office` 按 `<payload>/../office-skills` 找资产）：

```
resources/runtime/                     # gitignore，构建期产物
├─ primary-runtime/
│  ├─ runtime.json                     # desktopVersion/platform/arch/python/pythonPackages/payloadDigest
│  └─ dependencies/python/             # astral python-build-standalone（install_only_stripped）
│     ├─ bin/python3
│     └─ lib/python3.12/site-packages/ # 13 个 sha256 锁定 wheel，免 pip 解包（fflate）
└─ office-skills/                      # 从 resources/engine 的 dsh-skill-office/assets 复制
```

**构建与验证**：

- `pnpm run prepare-primary-runtime`：按本机平台下载并组装载荷（`--target X` 交叉；`--full` 额外带 Node+pnpm，默认 python-only）。**sha256 全量校验**（`scripts/primary-runtime.lock.json` = 上游 lock 的 verbatim 副本）；缓存进 `resources/downloads`。
- `pnpm run smoke-primary-runtime`：载荷自检（解释器 + numpy/pandas + 五件套版本 + `check_office.py` + `pip check`）；`scripts/primary-runtime-smoke.py` 是上游 smoke.py 的 verbatim 副本。
- `pnpm run smoke-office`：**发货级**端到端——叠加层组合检查（`--dump-config`）→ 引擎带 env+patch 真启动 → 载荷 Python 生成 docx → `check_office.py` → 自带 LibreOffice 转 PDF。
- **镜像**（国内网络，GitHub 直连 ~4 KB/s 实测）：`DSH_PRIMARY_RUNTIME_PYTHON_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone/`、`DSH_PRIMARY_RUNTIME_WHEEL_MIRROR=https://pypi.tuna.tsinghua.edu.cn/`、`DSH_PRIMARY_RUNTIME_NODE_MIRROR=https://registry.npmmirror.com/-/binary/node/`。镜像只换 URL 前缀，字节与 sha256 不变；**默认仍走官方源，CI（GitHub runner）无需设置**。

**运行期接线**（壳侧，`src/main/index.ts`）：

- `engineNodeEnv()`：payload 存在时注入 `DSH_BUNDLED_PRIMARY_RUNTIME=<Resources>/runtime/primary-runtime`；`resources/office.patch.yml` 里的 `!!js` 表达式在**引擎自身 boot 进程**里解析它（引擎给子进程擦除 DSH_* 变量不影响——插件在进程内已解析成绝对路径）。
- `engineCliArgs()`：overlay 存在时给引擎加 `--patch <绝对路径>`。**位置铁律**（spike 实测）：启动器选项必须在 `--profile web` 之后、app-args（`--port`/`--no-open`）**之前**，否则 `error: unknown option '--patch'`；`nodeArgs` 是 Node 级参数（在脚本之前），不能复用，所以 `harness.start()` 有独立的 `args` 通道；`tools()`（dump-config）同样带上；**`dsh plugin` 不带**（pnpm 参数通道）。
- **降级**：overlay 里两个插件都带 `disabled: !env` 表达式——删掉 `resources/runtime`（如 dev 未准备载荷）引擎照常启动，只是没有 office 技能；LibreOffice 转换不受影响。

**生命周期注意**：

- 载荷与引擎**同生命周期但分开更新**：应用内「引擎更新」（`updater:apply`）只换 `resources/engine`，不动 `resources/runtime`。office-skills 是打包时从当版引擎复制的——新引擎的 skill 代码配旧资产，目前格式稳定（SKILL.md + frontmatter），但升级引擎后应重新 `prepare-primary-runtime`（CI 每次都现做）。
- 体积：载荷解包后 ~247 MB（x64），dmg 预计 +80~100 MB；许可见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)（CPython PSF + 13 wheel + LibreOffice MPL-2.0）。
- **坑**：wheel 解包曾用 `extract-zip@2.0.1`，它在 **Node ≥ 25 下 Promise 不 settle、进程静默 exit 0**（Node 24 正常，CI/上游无感）——已改用纯 JS 的 `fflate`，任何 Node 版本可用。

### 2.10 右键上下文菜单（context-menu）

**问题**：窗口内右键无任何反应——引擎 UI（127.0.0.1 页面）、管理窗口、状态壳全部如此，导致「鼠标选中 → 右键 → 复制」这类基本操作不可用。

**根因**：Electron 默认**不显示任何右键菜单**，必须由壳在主进程监听 `webContents` 的 `context-menu` 事件并自行 `Menu.popup()`。本仓库此前从未处理该事件，右键自然是个空操作；应用菜单（`Menu.setApplicationMenu`）只管菜单栏，与右键无关。引擎 UI 本身仅对 JSON 树展开器等两个小组件设了 `user-select: none`，正文文本可以正常选中——缺的只是右键菜单这一环。

**修复（`src/main/index.ts` 的 `installContextMenu(win)`，`createWindow` / `createManagerWindow` 各自调用）**：

- 按点击目标动态组菜单，文案与应用菜单保持一致（中文）：
  - 可编辑区（`params.isEditable`）：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选（全部用 `role`，走 Chromium 原生编辑命令，与页面 JS 无关）；
  - 选中文本（`params.selectionText` 非空）：复制 / 全选；
  - 其余空白处：仅全选；
  - 链接（`params.linkURL` 非空）：复制链接地址（主进程 `clipboard.writeText`）+ 打开链接（`shell.openExternal`）。
- `popup({ window: win })` 显式传窗口（多窗口共存时必要）。
- 要点：`context-menu` 事件覆盖主窗口加载的任意页面（状态壳、引擎 UI），一处挂载全窗口生效；菜单项用 `role` 而非手动发 IPC，粘贴/复制对引擎 UI 与壳页面都可靠。若未来引擎 UI 自带自定义右键菜单（DOM 层），两者会叠加——届时可在此事件里判断后决定是否接管。

---

## 三、打包

> 打包 = 从源码产出可分发的安装包（`release/` 下的 dmg/zip/exe/AppImage）。发布（打 tag → CI 三平台 → draft release → 公开 → GitCode 镜像）是打包的下一环，见「四、发布」与发布总结.md。

### 3.1 从零到出包（首次 / 换机器完整顺序）

```sh
mise install              # 1. 工具链：按 mise.toml 装 Node 24 + pnpm（装完 `mise use` 信任）
cp .env .env.local        # 2. 可选：本机私有凭据模板（token / 证书 / Apple ID 等）
pnpm install              # 3. 壳依赖（内置 pnpm 随之装进 node_modules，打包时进 asar）
pnpm run install-engine   # 4. 生成 resources/engine（registry 拉锁定版本，约 7 分钟）
pnpm run prepare-primary-runtime  # 5. 生成 resources/runtime（Office 载荷，§2.11；国内网络先配该节的镜像 env）
pnpm run rebuild-engine   # 6. 可选：非 N-API 原生模块按当前 Electron ABI 重编（升级 Electron 大版本后必跑）
pnpm run smoke            # 7. 可选：引擎 boot 冒烟（动过引擎/安装逻辑后跑）
pnpm run smoke-office     # 8. 可选：Office 能力端到端（叠加层 + boot + 创作/检查/转换）
pnpm build                # 9. 打包当前平台、当前架构产物到 release/
```

**升级已有引擎版本**：用 `pnpm run engine-update` 一条命令代替上面第 4~8 步（查最新 → 改 DEFAULT_ENGINE_VERSION → install → rebuild → smoke，改完 review 未提交的 DEFAULT_ENGINE_VERSION diff）。首次 / 换机器仍按 4~9 原样跑——`engine-update` 默认会查 npm 并可能改写 DEFAULT_ENGINE_VERSION，不适合初始化场景。

> ⚠️ **`pnpm build` 不会安装引擎**：electron-builder 的 `extraResources` 只是把 `resources/engine` **原样拷进应用包**，不会帮你拉依赖。换机器 / 清了 `resources/` / 引擎版本变了却跳过第 4 步，直接 build 打出的应用**没有引擎**，启动会弹「未找到 dsh 引擎」。同理**也不会准备 Office 载荷**（第 5 步）——缺载荷时应用照常启动，只是没有 Python office 技能（叠加层自动禁用，§2.11）。

**只改壳代码（`src/`）时**：第 1~4 步不用重跑，直接 `pnpm build`（内部已含 compile）即可。

### 3.2 打包命令速览

| 命令 | 作用 | 何时跑 |
|---|---|---|
| `pnpm build` | compile + electron-builder 出**当前平台、当前架构**产物到 `release/`（本机 Intel Mac → x64 dmg/zip） | 打本地自测包；签名/公证凭据从 env 三层文件自动加载（§2.7），无凭据则跳过 |
| `pnpm run engine-update` | 一条命令升级引擎：查最新 → 改 `DEFAULT_ENGINE_VERSION` → install → rebuild → smoke（`--no-bump` 仅按当前重装） | 升级引擎版本（本地，§2.4） |
| `pnpm run install-engine` | 装锁定版本引擎到 resources/engine（registry 主路径，首次约 7 分钟） | 首次、升级引擎、换机器 |
| `pnpm run prepare-primary-runtime` | 组装 Office 载荷到 resources/runtime（sha256 锁定下载 + 免 pip 解 wheel，§2.11） | 首次、升级引擎后、CI |
| `pnpm run rebuild-engine` | 重编引擎非 N-API 原生模块 | 换 Electron 大版本后 |
| `pnpm run smoke` | 引擎冒烟（Electron-as-Node boot + 健康检查 + 优雅退出） | 动过引擎/安装逻辑后 |
| `pnpm run smoke-primary-runtime` / `smoke-office` | 载荷自检 / Office 能力端到端（§2.11） | 动过载荷、office 接线后 |
| `pnpm run compile` | 只编译不打包（tsc + 拷静态到 dist/） | 只改 main/preload/renderer 想快速手测 |

完整命令表见 §2.7。⚠️ **别用 `pnpm pack`**：那是 pnpm 内置命令（等价 `npm pack`，打 tarball），不会执行本项目的打包脚本。

### 3.3 打包原理（electron-builder.yml 关键点）

- **引擎在 asar 外**：`extraResources` 把 `resources/engine` 拷到应用包 `Contents/Resources/engine`（`process.resourcesPath/engine`），原生模块走真实文件路径。**因此打包前必须有 `resources/engine`**（§3.1 第 4 步）。
- **壳在 asar 内**：`files: [dist/**/*, scripts/**/*.mjs, package.json]` 把程序、脚本与依赖打进 `app.asar`；内置 `pnpm`（`dependencies`）随之进 asar——打包态「应用引擎更新 / 插件安装」靠 asar 内 pnpm + userData 垫片跑（§2.5/§2.6）。
- **三平台 target**：mac → dmg + zip（zip 是 electron-updater 增量更新必需）；win → nsis；linux → AppImage。mac 不钉 arch：本机 Intel 出 x64、CI macos-15 出 arm64，双架构合并见发布总结.md §4.3。
- **publish 配置**：`provider: github` + `${env.GH_OWNER}`/`${env.GH_REPO}`（来自 `.env`，`pnpm build` 用 `--env-file-if-exists` 自动加载）；本地 `pnpm build` 不发布（publish 只在 CI tag 流程发生）。
- **签名 / 公证**（mac）：三种模式，`identity` 是 `${env.CSC_IDENTITY}` 宏（每个构建必须定义，否则构建失败）——① 默认（共享 `.env`）：`CSC_IDENTITY=-` → ad-hoc 签名（无证书环境可用，但 Squirrel.Mac 自动更新不可用：每次构建身份随机，更新永远被拒）；② **路线一自签名**：`pnpm run sign-cert` 生成固定 `release/keys/dsh-release.p12` 并写入 `.env.local`（`CSC_IDENTITY=` 空 + `CSC_LINK`/`CSC_KEY_PASSWORD`/`CSC_NAME`）——**每个版本用同一 .p12 签名**，自动更新可用，无需 Apple Developer Program；③ Developer ID 证书同理（付费，可公证）。`CSC_IDENTITY_AUTO_DISCOVERY=false`（共享 .env）关闭钥匙串自动发现（防误用公司证书），身份由 `CSC_NAME` 显式指定。自签名未公证：新 Mac 首次打开需右键 → 打开。hardenedRuntime 常开。
- **`npmRebuild: false`**：原生模块不交给 electron-builder 重编，改由 `rebuild-engine` 显式管理（§2.3）。

### 3.4 产物与验证

`pnpm build` 产物在 `release/`：

| 平台 | 产物 |
|---|---|
| macOS | `dsh-desktop-<v>-<arch>.dmg` / `-<arch>-mac.zip`（+ `latest-mac.yml`） |
| Windows | `dsh-desktop-<v>.exe`（NSIS）+ `latest.yml` |
| Linux | `dsh-desktop-<v>.AppImage` + `latest-linux.yml` |

**打包前自检**：`pnpm run smoke` 必过；打开产物验证「引擎已安装」（管理窗口显示引擎版本）而不是「未找到 dsh 引擎」——后者九成是漏了 §3.1 第 4 步。

### 3.5 打包环境要求

- **工具链**：mise 管 Node 24 + pnpm（`mise.toml`）；`pnpm install` 前先 `mise install` + `mise use`。
- **网络**：GitHub 直连不稳时设 `ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` 下载 Electron 二进制（**本机已配在 `.env.local`**，build/install-engine 自动加载；勿写进共享 `.env`，否则 CI 也走镜像反而变慢）；npm registry 可另配镜像源。
- **env 三层文件**：`.env`（共享：GH_OWNER/GH_REPO）→ `.env.development`（团队覆盖，如 DSH_CHECKOUT）→ `.env.local`（本机私有，token/证书，gitignore）。build/publish 脚本用 `--env-file-if-exists` 按序加载，已 export 的环境变量优先（§2.7）。

### 3.6 打包坑速查（都踩过）

- `pnpm build` 出的包启动弹「未找到 dsh 引擎」 → 漏跑 `pnpm run install-engine`（§3.1 第 4 步）；或 `resources/engine` 里 `node_modules` 缺失。
- `pnpm build` 报 `⨯ fetch failed`（packaging 阶段）→ electron 二进制下载失败：GitHub 直连慢/超时，或 `~/Library/Caches/electron/` 里的缓存 zip 校验不通过（续传损坏）。修复：设 `ELECTRON_MIRROR`（§3.5，本机已配 `.env.local`）→ 删除 `~/Library/Caches/electron/` 里损坏的 zip → 重跑 `pnpm build`（sha256 校验通过后缓存，之后不再下载）。
- pnpm 报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 或 `ERR_PNPM_OUTDATED_LOCKFILE` → `CI=true pnpm install --no-frozen-lockfile`。
- 打包崩溃 `Cannot read properties of undefined (reading 'ReadWrite')` → `@electron/get` 覆盖被移除（pnpm-workspace.yaml 的 overrides，§1.2）。
- 打包 / `pnpm list` 报 `ERR_SQLITE_ERROR: unable to open database file`（electron-builder 的 node-module-collector 阶段失败）→ **pnpm 全局 store 的 `index.db` 损坏**（本机 `~/Library/pnpm/store/v11/index.db`，异常中断写坏）。修复：备份该文件（`mv index.db index.db.bak`）后 pnpm 自动重建索引。**这不是 electron-builder 的 bug**；`pnpm list --depth 0` 可快速复现判断。
- mac 打包 `EMFILE: too many open files`（osx-sign 遍历引擎 ~34k 文件）→ 已修：osx-sign walkAsync 串行化（patchedDependencies）+ CI 抬 `kern.maxfilesperproc`/`ulimit`（发布总结.md §5）。
- mac 产物提示「无法验证开发者」→ ad-hoc / 自签名（未公证）正常现象，右键 → 打开；或 `xattr -cr`（一键安装脚本已自动处理，使用总结.md §1）。
- Intel x64 包 CI 出不了 → 由本机 `pnpm build` 补发，`publish-release --with-x64` 合并（发布总结.md §4.3）。

### 3.7 与发布流程的衔接

出包之后进入发布：`pnpm run release`（累加版本 + tag + push）→ CI 三平台打包建 draft release → `publish-release` 公开（Intel 本机加 `--with-x64`）→ `download-release` + `sync-domestic` 镜像 GitCode。完整流程见「四、发布」与发布总结.md。

---

## 四、发布

> 发布全流程、命令、环境坑已抽到独立文档 **docs/发布总结.md**（版本规则、CI 触发、mac 双架构、GitCode 镜像、签名/公证、环境坑）。本文只保留发布相关的架构结论。

- **版本号唯一来源**：`package.json` 的 `version`（git tag 恒为 `v<version>`）；正常流程所有命令自动读它，不传版本号。
- **发布命令**：`pnpm run release`（发版入口）→ CI 自动三平台打包建 draft release → `pnpm run publish-release`（默认仅发布）或 `--with-x64`（Intel 本机补 x64 + 发布）→ `pnpm run download-release` + `pnpm run sync-domestic --dir`（GitCode 镜像）。
- **架构结论**：构建只在 GitHub Actions（唯一免费 macOS runner）；GitCode 只做镜像/更新源，不做构建；`--from-github` 已废弃（国内拉 GitHub 大文件不可行）。
- **签名结论**：`identity: ${env.CSC_IDENTITY}` 宏，三种模式——默认 `CSC_IDENTITY=-` 为 ad-hoc；`pnpm run sign-cert`（路线一自签名，固定 .p12，macOS 自动更新可用；完整说明见 README.md「macOS 签名」）；Developer ID + 公证（付费）。`CSC_IDENTITY_AUTO_DISCOVERY=false` 关闭钥匙串自动发现，身份由 `CSC_NAME` 显式指定。

---

## 五、维护速查（壳）

| 任务 | 步骤 |
|---|---|
| 升级引擎版本 | `pnpm run engine-update`（默认查 npm latest 并改写 `DEFAULT_ENGINE_VERSION`，`--no-bump` 仅按当前重装）→ review 未提交的 DEFAULT_ENGINE_VERSION diff（`git diff scripts/install-engine.mjs`）→ 提交 → 发版 |
| 升级 Electron | 改 package.json 版本 → `CI=true pnpm install --no-frozen-lockfile` → 核对内嵌 Node 满足引擎 engines（≥ 40 = Node 24）→ `rebuild-engine` → `smoke` |
| 新增管理窗口功能 | 后端放 electron-free 模块（路径注入）→ index.ts 加 IPC handler → preload.cjs 加桥方法 → manager.html/js 加控件 |
| 出正式发布物 | 见「四、发布」与 docs/发布总结.md（`release` → CI → `publish-release` → `sync-domestic`） |
| 排查引擎问题 | 管理窗口日志 → `$DSH_HOME` 结构 → `resources/engine/engine.json`（来源/版本）→ 复现时用 `DSH_ENGINE_BIN` 指到可疑入口 |
| 插件相关维护 | 见《dsh插件开发.md》 |
