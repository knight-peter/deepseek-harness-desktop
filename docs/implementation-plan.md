# dsh-desktop 实施计划

DeepSeek Harness 的 Electron 桌面壳。壳负责托管引擎、提供窗口、管理插件与更新；业务功能 100% 复用上游 `dsh web` 原版，上游仓库的持续更新不影响壳。

- 状态：Phase 0–6 已实施并验证，Phase 7 部分完成（CI + 文档；签名/发布通道待定）（2026-08-16；2026-08-16 代码审查修复：诊断/脚手架/原子升级/日志缓冲/CSP）
- 上游：https://github.com/deepseek-ai/deepseek-harness（下文简称「上游」）
- 上游版本基线：checkout `0.1.0-rc.5`；npm `latest` 已到 `0.1.0-rc.6`（2026-08-14 核实）
- 相关讨论：见本仓库 `docs/` 后续补充的设计笔记

## 1. 背景与目标

### 1.1 背景

- deepseek-harness 是通过 Web UI 使用的 agent harness，`dsh web` 启动一个 Node 宿主进程，内置 HTTP 服务器（默认 `127.0.0.1:3080`），向 index.html 注入 `window.__DSH_BOOT__` 入口图后，浏览器壳才挂载整个客户端。**Web UI 不是独立前端，必须由宿主进程承载。**
- 上游仓库持续更新，且处于预发布期（`0.1.0-rc.5`），磁盘格式不承诺兼容。
- 需要为桌面用户提供一个零依赖、开箱即用的窗口形态，并保留方便的插件开发/调试/安装路径。

### 1.2 目标

1. 用 Electron 做窗口壳，托管 `dsh web` 子进程，复用 100% 原功能，上游零改动。
2. 上游更新不影响壳：壳依赖 npm 发布版，与源码解耦；同时支持「开发模式」直接托管源码 checkout。
3. 运行时用 Electron 内嵌 Node，用户零依赖（不额外内置官方 Node；必要时启用兜底）。
4. 提供方便的插件安装、开发、调试体验。

### 1.3 非目标（刻意不做）

- 不实现插件加载/注册逻辑、不管理 profile bundles 列表、不实现 HMR —— 上游均有成熟实现，壳只做「调命令、捕获输出、解析状态、编排重启、展示」。
- 不做「Electron 进程内嵌入 dsh」（原因见 §3.5）。
- 不 fork 上游前端。

## 2. 已确认的架构决策

| 编号 | 决策 | 理由 |
|---|---|---|
| AD-1 | 独立仓库 `~/Learn/dsh-desktop`，不放进上游仓库 | 上游持续更新，壳与源码彻底解耦；合并/更新互不干扰 |
| AD-2 | Electron 只做窗口壳；引擎是壳托管的 `dsh web` 子进程（用 Electron 内嵌 Node 派生，`ELECTRON_RUN_AS_NODE=1`）；BrowserWindow 加载 `http://127.0.0.1:<随机端口>` | 复用原版 UI 零改动；进程隔离、生命周期与窗口解耦；内嵌 Node 的 ABI 风险与对策见 §3.4/§8 |
| AD-3 | 发布版引擎用 npm 发布包 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-web-frontend`，锁版本装在壳的 `resources/engine` 独立安装区；上游未发布/发布不全的包退化为「锁定上游 commit 构建 + `npm pack` tarball」安装（见 §3.3） | 开箱即用、版本可控、升级只换引擎；不依赖上游发布节奏 |
| AD-4 | 引擎子进程用 **Electron 内嵌 Node** 运行（`ELECTRON_RUN_AS_NODE=1`）；锁定 Electron ≥ 40（Node 24）满足上游 `^22.19 \|\| >=24`；原生模块用 `@electron/rebuild` 重编；**内置官方 Node 为兜底**（2026-08-14 定，见 §3.4） | 零额外运行时体积、用户零依赖；风险已知且可控：ABI 差异、版本随 Electron 走，出问题可低成本切回官方 Node 兜底 |
| AD-5 | 用户数据全部留在 `$DSH_HOME`（默认 `~/.dsh`），壳不迁移、不接管 | 与上游 CLI 共享数据，升级只换引擎 |
| AD-6 | 插件安装/卸载/更新一律走上游 `dsh plugin --profile web <pnpm args>`，壳只编排重启 | 上游已实现 pnpm 安装 + bundles reconcile，壳不重复造轮子 |
| AD-7 | 结构变更（装/卸/更新插件）后自动重启引擎；配置变更走 profile patch HMR 热生效 | web profile 的 HMR 是配置级的，新行不一定能热挂载，而引擎 boot 仅数秒 |
| AD-8 | 发布版附带 pnpm（作为壳的依赖，用内置 Node 调用），不要求用户系统安装 pnpm | `dsh plugin` 依赖 PATH 上的 pnpm，零依赖目标要求壳自带 |
| AD-9 | 单实例锁（Electron `requestSingleInstanceLock`） | 两个壳同时写 `$DSH_HOME` 会冲突 |
| AD-10 | 引擎异常退出（非 0 退出码）时壳不自动重启，弹错误诊断 | 防止崩溃死循环 |

## 3. 总体架构

### 3.1 运行时拓扑

```
┌───────────────────────────── dsh-desktop (Electron) ─────────────────────────────┐
│                                                                                  │
│  Main 进程                                                                       │
│  ├─ harness.ts    引擎子进程管理：选 Node → spawn dsh web → 解析 stdout URL 行    │
│  │                → 健康检查 → 优雅停机（SIGTERM → 等待 → 强杀）                  │
│  ├─ plugins.ts    插件管理：调 dsh plugin 命令、解析输出、编排重启                │
│  ├─ updater.ts    引擎版本检查/升级 + electron-updater 应用更新                  │
│  └─ index.ts      生命周期、单实例锁、托盘、窗口                                 │
│         │                                                                        │
│         │ spawn（Electron 内嵌 Node：ELECTRON_RUN_AS_NODE=1）                                  │
│         ▼                                                                        │
│  ┌─────────────────────────── dsh web（子进程）──────────────────────────┐      │
│  │  Node 宿主：web profile（$DSH_HOME/profiles/web）                      │      │
│  │  bundles: dsh-base + dsh-web-app + 用户插件分层                         │      │
│  │  HTTP 服务器 127.0.0.1:<port>（随机端口）                               │      │
│  │  └─ 注入 window.__DSH_BOOT__ → 服务 /api、/plugins/<id>/client.js      │      │
│  └───────────────────────────────────────────────────────────────────────┘      │
│         │ http://127.0.0.1:<port>                                                │
│         ▼                                                                        │
│  BrowserWindow（contextIsolation: true, nodeIntegration: false）                 │
│  └─ preload contextBridge：harness 状态 / 插件管理 API / 版本信息                 │
└──────────────────────────────────────────────────────────────────────────────────┘

用户数据（引擎读写，壳不接管）：$DSH_HOME
├─ profiles/web/         profile 目录：package.json（deps + dsh.profile.bundles）、
│                        cordis.patch.yml、pnpm-workspace.yaml
├─ cordis.patch.yml      home 级用户补丁层
├─ storages/ sessions/ credentials/ settings/ ... 会话与设置数据
└─ .agent-presets/       每会话 agent 组合
```

### 3.2 引擎托管（harness.ts）关键点

1. **运行时选择**：默认用 Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE=1` + `process.execPath` 派生引擎子进程）；启动时核对 `process.versions.node` 满足引擎 engines（`^22.19 || >=24`，锁定 Electron ≥ 40 即 Node 24）；兜底方案启用时切换为内置官方 Node（§3.4）。
2. **启动**：以 `ELECTRON_RUN_AS_NODE=1` 用 `process.execPath` 派生 `<node>`，**前置 `--expose-internals`**（原因见 §3.4 实测发现），执行 `<resources>/engine/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 0`（随机端口），监听 stdout，匹配 `dsh web: http://127.0.0.1:<port>` 行（上游启动时打印 URL）拿到真实端口；就绪后 BrowserWindow 加载。
3. **健康检查**：端口可连 + `GET /` 返回 200 且页面包含 `__DSH_BOOT__` 注入脚本（生产模式禁止加载裸 Vite/静态页）。
4. **优雅停机**：关窗 → 向引擎发 SIGTERM → 等待退出（上限 N 秒）→ 超时强杀；退出码 0 视为正常关闭静默处理，非 0 弹错误诊断（AD-10）。
5. **启动失败诊断**：上游 `assertEntriesLoaded/Activated` 会把解析不到的插件变成启动失败并指名插件名，`installFailLoud` 输出一行带标签的 stderr 后 `exit(1)`；壳解析 stderr → 渲染友好错误卡片（「插件 X 未找到」等），附完整日志。**已实现（2026-08-16）**：`tools.ts` 的 `diagnoseStartupFailure` 模式匹配（loader 条目/缺包/pnpm/网络）生成友好提示，harness 日志环形缓冲（500 行）供诊断与晚开窗口回放。

### 3.3 资源布局（发布版）

```
resources/
└─ engine/              dsh 引擎独立安装区（resources/node/ 兜底保留，切换方案时启用，见 §3.4）
   └─ node_modules/     @deepseek-ai/dsh、@deepseek-ai/dsh-web-frontend 及其依赖
                        （npm 安装，普通布局；不用 pnpm 隔离布局）
```

**关键约束**：上游 `dsh-web-app` 通过 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 定位前端 dist，因此 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-web-frontend` 必须装在同一棵 `node_modules` 树中。引擎目录整体 `asarUnpack`（原生模块 + require.resolve 需要真实文件路径）。

**引擎来源（两条路径，共用同一 `resources/engine` 布局）**：

1. **npm registry（主路径）**：`npm install @deepseek-ai/dsh@<锁定版本> @deepseek-ai/dsh-web-frontend@<锁定版本>`。已核实（2026-08-14，registry.npmjs.org）：`@deepseek-ai/dsh` 存在且为公开包，首次发布 2026-08-10，`dist-tags.latest`/`next` 均为 `0.1.0-rc.6`（比当前 checkout 的 `0.1.0-rc.5` 更新）；`@deepseek-ai/dsh-web-frontend`、`dsh-web-app`、`dsh-base`、`dsh-host-webserver` 等关键依赖均存在。registry 包内容即上游 build 产物（`lib/` + `dist/`）——发布版引擎**不是**手动拷贝 dist，而是由 npm 按依赖图搬运同一批产物。
2. **上游构建兜底**：并非全部包都已发布（已核实 `@deepseek-ai/dsh-sdk-server` 404，发布集随时间变化）。所需包缺失时：锁定上游 commit → `pnpm install && pnpm build` → 对缺失包 `npm pack` 打成 tarball → `npm install <tarball>` 进同一 `resources/engine`。内容等价于路径 1，仅搬运来源不同。

两条路径运行时无感；`scripts/install-engine.ts` 统一实现「先查 registry，缺失则走构建兜底」。**体积剪枝（2026-08-16）**：安装后自动删除非当前平台的 `prebuilds/` 目录（node-pty 等 node-gyp-build 包的跨平台预编译二进制，本机实测省 ~58MB：352M → 294M）；保守策略——仅当 `prebuilds/` 内含当前平台目录时才剪，剪枝后 `smoke` 通过。

### 3.4 运行时选择：Electron 内嵌 Node（决策记录，2026-08-14）

**决策**：引擎子进程用 Electron 内嵌 Node 运行，机制为 `ELECTRON_RUN_AS_NODE=1` + `spawn(process.execPath, ...)`——把 Electron 二进制当作普通 Node 使用，仍是独立子进程，壳与引擎的进程隔离不变（AD-2）。不额外内置官方 Node 二进制；若运行期出现原生模块 ABI 问题且 `@electron/rebuild` 无法低成本解决，切换回内置官方 Node 兜底（见下）。

**已知事实与风险**：

- **版本**：内嵌 Node 版本随 Electron 发布节奏走、不可独立升级。已核实（2026-08，endoflife.date）：Electron 39 = Node 22，Electron 40 起 = Node 24。dsh 引擎要求 `^22.19 || >=24`，因此**锁定 Electron ≥ 40（Node 24，当前稳定 43.x）**，启动时核对 `process.versions.node` 满足 engines，不满足则挡在启动前；Electron 升级换 Node major 时必须重新核对。
- **ABI**：内嵌 Node 与官方 Node 的 `NODE_MODULE_VERSION` 不同，按官方 Node ABI 编译的原生模块（dsh 自带 Linux 的 `node-addon-landlock-run`、生产 bin 可选依赖 `node-addon-require-builtin`、第三方插件的 node-gyp 依赖）可能加载失败。对策：Phase 1 设 ABI 验证门（实际加载检查）；受影响模块用 `@electron/rebuild` 对 `resources/engine` 重编；重编不可行时启用兜底。
- **实测发现（2026-08-14，Electron 43 / 内嵌 Node 24.18.1）**：原生模块本身可加载（N-API prebuilt，ABI 兼容）；但 **vendored loader 的原生 internals 钩子（node-addon-require-builtin）在 Electron 内嵌 Node 下静默失效**，导致裸插件包名（如 `@deepseek-ai/cordis-plugin-timer`）解析失败、引擎 boot 报 `ERR_MODULE_NOT_FOUND`。**修复：引擎子进程前置 `--expose-internals` 启动**，loader 检测到该 execArg 后走纯 `require` 回退路径（不依赖原生钩子）；已实测引擎在 `--expose-internals` 下正常 boot 并服务页面。
- **一致性**：同一引擎在系统 Node（CLI/开发模式）与 Electron 内嵌 Node 下行为可能因 ABI 差异不一致；发布版以 Electron 内嵌 Node 为准，开发模式默认仍用系统 Node（checkout 的 `pnpm dsh`），遇 ABI 问题时再切换。

**兜底路径（用户已确认）**：恢复「内置官方 Node.js 发行版二进制」（nodejs.org 构建，约 30MB，`resources/node/`），`harness.ts` 运行时选择改为「内置官方 Node → Electron 内嵌 Node」；两条路径共用同一 `resources/engine`，切换只改 spawn 的 Node 可执行文件。

### 3.5 为什么不做进程内嵌入（决策记录）

在 Electron main 里直接 import 并 `boot()` dsh 能拿到 service 级集成，但代价：Electron 的 Node ABI 与系统 Node 不同，原生模块（`node-addon-landlock-run` 等）需 electron-rebuild；生命周期与进程模型耦合；升级要跟着 Electron 重编。当前收益低——需要原生能力的地方上游 host 侧已有（如 `dsh-host-directory-picker-native` 原生目录选择器）。**先子进程方案；未来若需托盘/菜单直连 service，再评估 SDK（`@deepseek-ai/dsh-sdk`，stdio JSON-RPC 驱动运行时）作为桥。**

## 4. 插件设计（开发 / 调试 / 安装）

### 4.1 三类改动面，生效机制不同

| 改动面 | 典型内容 | 生效方式 | 需重启？ |
|---|---|---|---|
| 配置层 | `cordis.patch.yml` 改配置、启停已有行 | profile patch HMR（`watchUserPatches` 事务式重组） | 否（热生效） |
| 宿主插件 | 工具、服务、事件监听（Node 进程内） | 代码改动 | 是（boot 数秒，代价小） |
| 客户端插件 | `dsh.client` 浏览器半（UI 组件） | 重建 bundle；开发模式（`pnpm run dev:web` watcher）下走 client-hmr 链（SSE `/plugins/events` → invalidate → prefetch → refresh） | 开发模式否；发布模式重启+刷新 |

### 4.2 安装（面板三条路径）

| 路径 | 面板操作 | 底层命令 | 特殊处理 |
|---|---|---|---|
| npm registry | 搜索/输入包名，可锁版本 | `dsh plugin --profile web add <pkg>[@ver]` | 装完自动重启引擎；透传 pnpm 输出 |
| 本地源码 | 选择 `$DSH_HOME/plugins-local/<name>/` 目录 | `dsh plugin --profile web add file:<绝对路径>` | 必须绝对路径（上游 `anchorPathSpec` 会把相对路径锚到调用 cwd）；file: 为符号链接，重构建后生效 |
| git 仓库 | 粘贴 git URL | `dsh plugin --profile web add git+https://...` | pnpm ≥10 拦 prepare 脚本：把上游提示转成引导卡片 +「打开 pnpm-workspace.yaml 编辑 allowBuilds」 |

卸载/更新 = `dsh plugin --profile web remove|update <pkg>`。注册动作（reconcile `dsh.profile.bundles`）全部由上游完成，壳只读回 profile manifest 展示状态。

**实测（2026-08-16）**：fixture bundle（`test/fixtures/hello-bundle`）走通全流程——`add file:<绝对路径>` → bundles 自动 reconcile（`[dsh-base, dsh-web-app, dsh-hello-bundle]`）→ 引擎重启后挂载日志 `[hello-bundle] mounted` 出现 → `remove` 后 bundles 恢复原状。

### 4.3 调试

- **日志面板**：捕获引擎 stdout/stderr，tail / 清空 / 导出；harness 环形缓冲（500 行）保证晚开的管理窗口可回放。启动失败行、pnpm 输出都在里面。
- **启动失败诊断**：`diagnoseStartupFailure` 解析 stderr → 友好错误卡片（loader 条目指名、缺包、pnpm 失败、网络错误）；不自动重启（AD-10）。
- **配置树视图**：面板内只读展示 `dsh --profile web --dump-config` 结果，支持「装插件前/后 diff」，定位「为什么没生效」。
- **宿主插件迭代**：改代码 → 面板「重新加载引擎」→ 看日志。
- **断点调试（高级）**：以 `NODE_OPTIONS=--inspect=9229` 启动引擎，Chrome DevTools attach；壳只透传 env，零侵入。
- **客户端插件迭代**：开发模式 + `dev:web` 热重载；已知限制如实展示（热重载丢组件内 React state、失败无回滚，FAILED 状态在设置页插件清单可见）。
- **配置热更**：壳内置 patch 编辑器（保存前用上游 parser 校验），配置改动 HMR 热生效；结构性改动（增删行/新插件）提示「需要重启」，面板一键重启。
- **web UI 自带面**：设置页的插件清单（`plugin-inventory`，Loader 条目只读投影）与插件配置卡片（`ui-settings-plugins`）已存在；壳面板与其互补：UI 看状态，壳做安装/卸载/更新/重启动作。

### 4.4 插件作者工作流（端到端）

1. 脚手架：面板「新建插件」→ 生成模板到 `$DSH_HOME/plugins-local/<name>/`（`package.json` 声明 `dsh.bundle` + 函数插件入口 + `cordis.patch.yml`）并自动 `file:` 安装（已实现，2026-08-16）。
2. 挂载：模板放 `$DSH_HOME/plugins-local/` → 面板一键安装（file: 链接）→ 自动重启。
3. 迭代：宿主插件改代码 → 重启引擎 → 看日志；前端插件开发模式 HMR；配置走 patch 热更。
4. 验证：设置页插件清单（行已挂载）+ 日志无报错 + `--dump-config` 树确认分层位置。
5. 发布：`npm publish` → 用户面板搜索安装。

## 5. 更新策略

- **数据安全**：升级只换引擎，`$DSH_HOME` 原样保留（上游设计保证）。
- **引擎更新**：面板/自动检查 npm registry 最新版（对比锁定版本）→ 后台安装进 `resources/engine/` → 重启引擎。**升级前自动备份 `$DSH_HOME` 一次**（预发布期 `SESSION_FORMAT_VERSION=0` 不承诺兼容）。
  - **原子换装（2026-08-16 实现）**：已有引擎时安装进 `resources/engine.new`，验证通过后 swap 换入（失败/中断不动旧引擎）——满足「模拟升级失败不破坏旧引擎」验收。
  - **包管理器兜底（2026-08-16 实现）**：`install-engine.mjs` 优先 npm，无 npm 时用 PATH 上的 pnpm（打包态由 `cliCommandEnv` 的 shim 提供），§10 遗留项关闭。
- **运行时版本联动**：Electron 升级会同时更换内嵌 Node major（39 = Node 22，40 起 = Node 24）；升级前核对引擎 engines（`^22.19 || >=24`），不满足则禁止升级（§3.4）。
- **应用更新**：electron-updater 走 GitHub Releases（壳自身）。mac 自动更新依赖 zip target（已配 `dmg + zip`，2026-08-16；dmg 不能用于增量更新）。
- **开发模式**：指向 checkout，`git pull` 即可，壳无感。

## 6. 仓库结构

```
dsh-desktop/
├─ package.json            # deps: js-yaml / pnpm / electron-updater；devDeps: electron, electron-builder, TS
├─ electron-builder.yml    # 三平台打包配置（asarUnpack: resources/engine）
├─ .github/workflows/build.yml  # CI：lint/typecheck/install-engine/rebuild/smoke/pack
├─ .gitignore
├─ docs/
│  ├─ implementation-plan.md      # 本文档
│  ├─ 开发总结.md                 # 开发总结（含插件开发/测试调试）
│  └─ 使用总结.md                 # 使用总结（安装/插件/更新）
├─ src/
│  ├─ main/
│  │  ├─ index.ts           # 生命周期、单实例锁、菜单、窗口、IPC、更新接线
│  │  ├─ harness.ts         # 引擎子进程管理（§3.2）
│  │  ├─ config.ts          # 设置持久化（settings.json）
│  │  ├─ plugins.ts         # 插件管理后端（§4）
│  │  ├─ tools.ts           # dump-config / diff / patch 编辑器（§4）
│  │  └─ updater.ts         # 版本检查 / 备份 / 重装（§5）
│  ├─ preload/
│  │  └─ preload.cjs        # contextBridge API（harness/plugins/tools/settings/updater）
│  └─ renderer/
│     ├─ index.html/js      # 状态壳（启动中/错误/日志；运行后让位 web UI）
│     └─ manager.html/js    # 管理窗口（插件 / 调试 / 设置 三页签）
├─ scripts/
│  ├─ copy-static.mjs       # preload/renderer → dist/
│  ├─ install-engine.mjs    # resources/engine 安装锁定版本引擎（registry + 构建兜底）
│  ├─ rebuild-engine.mjs    # @electron/rebuild 引擎原生模块
│  └─ smoke.mjs             # 引擎冒烟（boot + 健康检查 + 优雅退出）
├─ test/fixtures/hello-bundle/  # 插件流程 fixture（装/卸实测用）
└─ resources/               # 运行期资源（install-engine 生成）
```

## 7. 实施阶段

每个阶段的验收标准必须可执行验证；除 Phase 0 外均基于前一阶段产物。

**实施状态（2026-08-16）**：

| Phase | 状态 | 说明 |
|---|---|---|
| 0–1 | ✅ | 可运行壳；引擎托管闭环验收项全部实测通过（含 `--expose-internals` 修复） |
| 2 | ⚠️ | mac 本机全链路通过（install-engine 588 包 / rebuild-engine / smoke PASS / 零环境变量出 UI，含原子换装 + prebuilds 剪枝 352M→294M）；产物 dmg 177M + mac zip 195M（auto-update），打包产物 .app 实机 boot 验证通过；win/linux 平台产物待 CI 构建验证 |
| 3 | ✅ | `plugins.ts` + 管理窗口；fixture `dsh-hello-bundle` 装 → reconcile → 挂载 → 卸 全流程实测通过 |
| 4 | ✅ | `tools.ts`：dump-config（15KB 组合树）、LCS diff、patch 校验（容忍 `!!js`）；实时日志面板（环形缓冲回放 + 导出）；启动失败诊断（`diagnoseStartupFailure`） |
| 5 | ✅ | 版本检查 / `$DSH_HOME` 备份 / 引擎重装已实现并实测；原子换装 + npm→pnpm 兜底（2026-08-16）；electron-updater 已接线（发布版启用） |
| 6 | ⚠️ | `config.ts`（settings.json）：checkoutPath / inspectPort / autoCheckUpdates；成为引擎来源第 4 优先级；「dev:web 客户端插件热重载」未实测（需上游 checkout + 客户端插件 fixture） |
| 7 | ⚠️ | CI workflow + 开发总结（含插件开发/调试）+ 使用总结文档已交付；签名证书与 GitHub Releases 发布通道待定 |

### Phase 0 — 仓库脚手架

- 任务：TypeScript + tsc + electron + electron-builder 骨架（渲染层极薄，不引 electron-vite/React）；eslint（typescript-eslint）；`.gitignore`；`electron-builder.yml` 最小配置。
- 交付物：`pnpm dev` 能弹出占位窗口。
- 验收：在干净环境执行 `pnpm install && pnpm dev` 出现窗口；`pnpm lint` 通过。

### Phase 1 — 引擎托管最小闭环（核心，优先做）

- 任务：
  - `harness.ts`：运行时选择（Electron 内嵌 Node：`ELECTRON_RUN_AS_NODE=1` + `process.execPath`；启动核对 `process.versions.node` 满足引擎 engines）→ spawn `dsh web`（随机端口）→ 解析 stdout URL 行 → BrowserWindow 加载 → 健康检查（含 `__DSH_BOOT__` 断言）。
  - 生命周期：关窗 → SIGTERM → 等待 → 强杀；退出码区分正常/异常；异常弹错误卡片 + 日志。
  - 单实例锁。
- 交付物：可运行壳，窗口内是完整原版 web UI。
- 验收：
  - 启动后窗口加载原版 UI，无白屏（页面含 `__DSH_BOOT__` 注入）。
  - 随机端口不与 3080 冲突；连续启动/退出 10 次无残留进程。
  - Electron 内嵌 Node 满足引擎 engines（Electron 43 / Node 24.18.1）；原生模块 ABI 加载验证通过（ABI 门）；`--expose-internals` 修复后引擎 boot、URL 解析、`__DSH_BOOT__` 健康检查、SIGTERM 优雅退出零残留——全部实测通过（2026-08-14）。
  - 人为制造引擎启动失败（如配置坏插件名）→ 壳展示指名错误，不自动重启。

### Phase 2 — 资源打包与发布构建

- 任务：
  - `scripts/install-engine.ts`：在 `resources/engine` 用 npm 安装锁定版本 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-web-frontend`（普通 node_modules 布局）。
  - 原生模块 ABI：`scripts/rebuild-engine.ts` 用 `@electron/rebuild` 按当前 Electron 版本重编 `resources/engine`，冒烟验证 `node-addon-require-builtin` 等可加载（ABI 门，见 §3.4）。
  - `electron-builder.yml` 三平台配置；引擎目录 asarUnpack。
  - 壳内置 pnpm（作为依赖），`plugins.ts` 用它执行 `dsh plugin`。
  - `scripts/smoke.ts`：打包产物冒烟——boot 引擎、HTTP 200、`__DSH_BOOT__` 断言、退出清理。
- 交付物：mac dmg / win nsis / linux AppImage。
- 验收：三平台产物在**无系统 Node、无 pnpm** 的干净环境开箱即用（引擎由 Electron 内嵌 Node 运行）；冒烟脚本通过；原生模块加载无 ABI 报错。

### Phase 3 — 插件管理面板

- 任务：
  - `plugins.ts` 后端：执行 `dsh plugin --profile web add|remove|update <pkg>`，解析输出与退出码；读 profile manifest 展示已装列表/版本。
  - preload API + 渲染层：搜索安装（npm）、本地目录安装（`plugins-local/` file: 链接）、git URL 安装（含 allowBuilds 引导卡片）、卸载/更新；装完自动重启引擎。
  - 启停/配置：写 profile `cordis.patch.yml`（校验后），配置改动热生效；结构性改动提示重启。
- 交付物：可用的插件管理界面。
- 验收：安装一个真实 bundle 插件 → 自动重启 → 设置页插件清单出现该行；卸载后分层移除；本地 file: 插件改代码重构建后重启即生效。

### Phase 4 — 调试与日志体验

- 任务：日志面板（tail/过滤/导出）；启动失败友好诊断；`--dump-config` 只读视图 + diff；「重新加载引擎」；`NODE_OPTIONS=--inspect` 高级模式；patch 编辑器。
- 交付物：调试工具集。
- 验收：坏插件安装 → 错误卡片指名插件；dump-config 视图与 `dsh --profile web --dump-config` 输出一致；配置热更演示（改 patch 不重启即生效）。

### Phase 5 — 更新机制

- 任务：npm registry 版本检查；升级前 `$DSH_HOME` 备份；引擎后台升级 + 重启；electron-updater 应用更新；版本信息展示。
- 交付物：自动/手动更新。
- 验收：引擎升级后 `$DSH_HOME` 数据（会话、设置、凭据）完整保留；备份可回滚；模拟升级失败不破坏旧引擎。

### Phase 6 — 开发模式

- 任务：设置项「使用源码目录」→ `harness.ts` 改为在 checkout 里跑 `pnpm dsh --profile web`；可选 `pnpm run dev:web` 前端 HMR；源码插件工作流（workspace 挂载）；模式切换确认与路径展示。
- 交付物：开发模式。
- 验收：指向 deepseek-harness checkout 后正常出窗；`dev:web` 下改客户端插件代码热重载；切回发布模式正常。

### Phase 7 — 发布与文档

- 任务：CI（构建 + smoke）；代码签名（mac notarize / win signtool）；用户文档 + 插件作者文档；首个 release。
- 交付物：正式发布通道。
- 验收：CI 绿；签名通过系统校验（Gatekeeper/SmartScreen 策略内）；文档覆盖安装、插件、更新、故障排查。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游预发布期格式不兼容（`SESSION_FORMAT_VERSION=0`） | 升级丢数据 | 升级前自动备份 `$DSH_HOME`；版本号显眼展示 |
| 上游包未发布/发布不全（已核实：`@deepseek-ai/dsh-sdk-server` 404） | 引擎装不上 | `install-engine.ts` 先查 registry，缺失包从锁定 commit 构建 + `npm pack` 兜底（§3.3）；发布集以脚本实时查询为准 |
| 上游 API/机制演进（reconcile、HMR、启动输出格式） | 壳解析逻辑失效 | 壳只依赖三个稳定触点：`dsh plugin` 命令、stdout URL 行、profile manifest；解析失败降级为「透传原始输出 + 日志」 |
| Electron 内嵌 Node 与官方 Node ABI 差异 | 原生模块（landlock、`node-addon-require-builtin`）加载失败 | Phase 1 ABI 验证门；受影响包用 `@electron/rebuild` 重编；不可行则切回内置官方 Node 兜底（§3.4） |
| loader 原生 internals 钩子在 Electron 内嵌 Node 下失效 | 裸插件包名解析失败、引擎无法 boot | `--expose-internals` 前置启动（已实测修复，2026-08-14）；未来若仍失效则评估内置官方 Node 兜底 |
| Electron 升级导致内嵌 Node major 变化（39 = Node 22，40 起 = Node 24） | 引擎 engines（`^22.19 \|\| >=24`）不满足 | 锁定 Electron ≥ 40；升级前核对 `process.versions.node`，不满足则挡在升级前（§3.4） |
| 随机端口竞态/健康检查误判 | 白屏或连错服务 | 解析 stdout URL 行为准 + 页面 `__DSH_BOOT__` 断言；启动后定期重检 |
| pnpm 缺失 | 插件安装不可用 | 壳自带 pnpm（AD-8） |
| 用户机器无 Node | 引擎无法启动 | 已消除：运行时由 Electron 内嵌 Node 提供；内置官方 Node 兜底保留 |
| 双实例写 `$DSH_HOME` | 数据损坏 | 单实例锁（AD-9） |
| 引擎崩溃循环 | 无限重启 | 非 0 退出不自动重启（AD-10） |
| 本地插件相对路径被 `anchorPathSpec` 锚错 | 装错目录 | 面板一律传绝对路径 |
| git 插件 prepare 被 pnpm 拦截 | 安装失败 | allowBuilds 引导卡片（§4.2） |

## 9. 里程碑（粗略）

| 里程碑 | 内容 | 预估 |
|---|---|---|
| M1 | Phase 0–1：可运行壳 | 0.5–1 周 |
| M2 | Phase 2–3：打包 + 插件管理 | 1–2 周 |
| M3 | Phase 4–5：调试体验 + 更新 | 1 周 |
| M4 | Phase 6–7：开发模式 + 发布 | 1 周 |

## 10. 待确认事项

- [x] 发布版引擎来源：npm registry 主路径 + 上游构建兜底（2026-08-14 定，见 §3.3）。
- [x] 运行时：Electron 内嵌 Node（`ELECTRON_RUN_AS_NODE=1` 派生引擎子进程）；内置官方 Node 保留为兜底（2026-08-14 定，见 §3.4）。
- [x] 端口策略：随机端口（`--port 0`）+ 解析 stdout URL 行（2026-08-14 定）。
- [x] 插件面板形态：壳内嵌页 + preload API（渲染层极薄、不引框架；2026-08-14 定）。
- [x] 自动检查更新：默认关，手动检查（2026-08-14 定）。
- [ ] 首个 release 的签名证书与发布通道（GitHub Releases）（Phase 7 前再定，不阻塞）。
- [x] 打包态引擎升级的包管理器：`install-engine.mjs` 已支持 npm→pnpm 兜底（`cliCommandEnv` shim 提供 PATH 上的 pnpm/node）（2026-08-16 关闭）。
- [x] 开发模式「使用源码目录」：由设置项落地（§6）；源码 launch（tsx）未做——当前用 checkout 已构建 CLI，行为等价（2026-08-16 定）。
- [x] Electron 版本：锁定 43.x（Node 24；2026-08-14 当前 stable 43.4.0，见 §3.4）。
