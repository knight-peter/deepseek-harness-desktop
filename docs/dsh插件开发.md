# dsh 插件开发

> 面向要写、要维护 dsh 插件的前端工程师。dsh 插件**跑在引擎（Node 进程）里，不是跑在浏览器里**——但如果你写过 Vite 插件、webpack 插件，或者接触过「分层配置/补丁」这类机制（如 overrides、patch-package、monorepo workspace 覆盖），很多概念是相通的。
>
> 相关文档：壳侧如何管理插件（装/卸/重启）见 **[`Electron基座应用开发.md`](Electron基座应用开发.md) §2.5**；终端用户怎么装插件见 [`使用总结.md`](使用总结.md) §4；本仓库的插件回归测试 fixture 在 `test/fixtures/hello-bundle/`。
>
> **上游文档**（deepseek-harness 仓库 `docs/` 下，本机路径 `~/Learn/deepseek-harness/docs/`；每份 `.md` 都有 `.zh.md` 中文版）：
> - **必读入门**：`cordis-primer.zh.md`（Cordis 五个核心概念）、`cordis-tutorial/`（从第一个插件到 HMR 的完整教程）
> - **扩展形态**：`cookbook/extension-cookbook.zh.md`（工具/钩子/UI/外部协议四种形态）、`cookbook/adding-a-tool.zh.md`（写工具插件）、`cookbook/adding-a-conversation-node.zh.md`（UI 对话节点）、`cookbook/adding-a-settings-card.zh.md`（设置卡片）
> - ⚠️ **`cookbook/adding-a-package.md` 不是第三方插件作者的主路径**——那是上游 monorepo **内部加 workspace 包**的流程（根配置注册、包拓扑、model experience）。你的插件直接 `npm publish` 即可，不用走它。

---

## 0. 前置概念（必读）

### 0.1 dsh 插件到底是什么

dsh（DeepSeek Harness）本身是一个 **Node 宿主应用**：它启动一个 Node 进程（引擎），在这个进程里运行一个「插件树」。你可以把引擎想象成一个**运行在 Node 里的操作系统**，插件就是**在这个系统里安装的应用程序/服务/UI 组件**。

插件的加载、注册、分层、HMR 全部由上游实现（Cordis 插件树）。**本桌面壳不参与插件的加载机制**，只负责「装、卸、重启、观察」——这是项目成立的根基（壳侧设计见 `Electron基座应用开发.md` §1.4 AD-6/AD-7）。

### 0.2 Cordis 插件树与「分层」概念

Cordis 是上游使用的插件框架（`@deepseek-ai/cordis`）。上游 `cordis-primer.zh.md` 总结了**五个核心概念**，先建立这个心智模型：

1. **插件是实现服务（Service）的对象**——可以是一个带 `inject` 和 `apply(ctx)` 的函数（最常见），也可以是一个 `Service` 子类，生命周期由 Cordis 挂载到当前上下文。
2. **上下文（ctx）是服务的容器**——一个服务占据一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）；其他插件**通过 key 查找服务，而非导入具体实现**（类比：前端里通过 context/依赖注入拿能力，而不是 import 具体类）。
3. **通过 `inject` 声明服务依赖**——插件声明所需的服务后，会**等待这些服务就绪才启动**；加载顺序由服务依赖表达，而不是手动编排启动序列。
4. **类型化事件用于通信**——服务通过事件名 + `ctx.emit` / `ctx.waterfall` / `ctx.parallel` / `ctx.serial` 分发，分别对应观察、包装（中间件，可短路）、并行扇出、按序执行。
5. **注册是可逆的副作用**——提示词片段、工具 schema、监听器通过 `ctx.effect()` / `ctx.on()` 安装，**reload 和 teardown 时会自动撤销**。

第二个概念是**分层（layer）与补丁（patch）**：dsh 的 web profile 由**多层配置叠加**而成。每一层是一份配置（YAML），后声明的层可以覆盖/插入/修改前面层的行。插件通过声明一个 **bundle patch 层**（`cordis.patch.yml`）把「自己的入口行」插入到配置树里——类比：你在一个有很多 override 的 CSS 变量体系里，往最后一层注入自己的变量。Cordis loader 读到的配置就是一个「配置项列表」（上游教程里叫 `cordis.yml`），每个配置项 `{ id, name, config }` 声明挂载哪个模块、传什么配置；patch 就是往这个列表里插行/改行。

### 0.3 壳与上游的职责边界

| 谁 | 干什么 |
|---|---|
| 上游（`dsh plugin` 命令） | pnpm 安装插件包、reconcile bundles、加载/注册插件树、配置 HMR |
| 壳（本仓库 `plugins.ts`） | 调 `dsh plugin add/remove/update`、读 profile manifest 展示列表、成功后**自动重启引擎** |
| 插件作者（你） | 写包、本地调试、`npm publish` |

一句话：**壳只负责「装、卸、重启、观察」，插件的加载与生效全是上游的事。** 你写的插件最终会被安装到 `$DSH_HOME/profiles/web` 这个 profile 里。

---

## 一、三类插件与生效方式

| 类型 | 声明 | 生效 | 需重启？ |
|---|---|---|---|
| **宿主插件**（工具/服务/事件，Node 进程内） | 普通 npm 包，入口被 loader 挂载 | 代码改动 | 是（boot 数秒，代价小） |
| **bundle 插件**（分层补丁） | package.json `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | 安装后自动进 profile bundles 分层；patch 行可再被用户层覆盖 | 装/卸后是（壳自动重启） |
| **客户端插件**（web UI 组件） | package.json 声明 `dsh.client`，bundle 有浏览器半 | 重建 bundle；开发模式（checkout + `pnpm run dev:web`）下 client-hmr 自动热更新 | 开发模式否；发布模式重启+刷新 |

逐类说明：

- **宿主插件**：就是普通 npm 包，运行在引擎进程里。典型的宿主插件做「服务/工具/事件」：提供 API 服务、订阅事件、挂 CLI 命令。它不直接碰 UI。
- **bundle 插件**：声明 `dsh.bundle.patch` 指向一个 YAML patch 文件。安装后，dsh 会把这份 patch 作为 profile 的一层**叠加进配置树**。patch 里 `insert` 一行 `{ id, name: <包名>/entry }`，就把「这个包的入口」挂进 web profile——之后入口模块（宿主半）会被加载。
- **客户端插件**：在 bundle 基础上声明 `dsh.client`，提供**浏览器半**（web UI 组件，Vue/React 等，随 `dsh-web-frontend` 一起打包进前端 bundle）。开发模式下可走 client-hmr 热更新。

> 对本仓库而言，你通过「新建插件」按钮生成的最小模板就是一个 **bundle 插件 + 宿主入口**（§3），跑通它之后再看客户端插件。

> **两种分类视角（别混淆）**：上表是**壳的管理分类**——按「壳怎么看到/管理这个插件」（manifest 依赖、bundles 分层、要不要重启）划分。上游 `extension-cookbook.zh.md` 用的是另一种**功能形态分类**：
>
> | 上游形态 | 干什么 | 对应壳分类 |
> |---|---|---|
> | **工具插件** | 给模型加工具（`ctx.tools.register()`，`adding-a-tool.zh.md`） | 宿主插件 |
> | **钩子插件** | 在 `agent/*`、`tools/*` 事件上挂监听器做权限门禁/日志/审计（waterfall 可短路决策） | 宿主插件 |
> | **UI 插件** | 从 `session/event` 事件流渲染对话 UI、注册对话节点（`adding-a-conversation-node.zh.md`） | 客户端插件 |
> | **外部协议驱动** | 把 dsh 接到 ACP / JSON-RPC 等外部协议（demo 见上游 `packages/examples/*-demo`） | 宿主插件 |
>
> 写插件时先想「我要提供什么功能形态」，再决定怎么声明——两者最终都落到同一个 Cordis 插件树上。

---

## 二、文件系统布局（插件都在哪）

```
$DSH_HOME（默认 ~/.dsh）
├─ profiles/
│  └─ web/                      # web profile：插件的安装目标
│     ├─ package.json           # manifest：dependencies + dsh.profile.bundles（见下）
│     ├─ node_modules/          # 已安装的插件包（pnpm 布局）
│     ├─ cordis.patch.yml       # 用户配置 patch 层（HMR 热生效对象）
│     └─ pnpm-workspace.yaml    # pnpm 配置（如 allowBuilds）
├─ plugins-local/               # 本地插件源码（壳的「新建插件」脚手架写到这里）
└─ ...                          # 引擎其他数据（会话、缓存等，壳不接管）
```

**profile manifest（`$DSH_HOME/profiles/web/package.json`）** 是壳展示「已装插件」的依据：

```jsonc
{
  "dependencies": {
    "my-plugin": "file:../../plugins-local/my-plugin"   // 用户装的插件
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "my-plugin"]
    }
  }
}
```

- `dependencies`：用户安装的插件包（壳的 `plugins.ts list()` 读这里展示列表）；
- `dsh.profile.bundles`：**bundle 分层清单**——`dsh-base` / `dsh-web-app` 是模板自带层（壳标记为 template，不可卸载），用户插件装完后由上游 **reconcile** 自动加进这个数组（`dsh plugin add` 触发）。

---

## 三、最小插件逐行讲解

用管理窗口「新建插件」生成的模板（或仓库 fixture `test/fixtures/hello-bundle/`）就是最小可用的 bundle 插件。三个文件：

### 3.1 `package.json`

```jsonc
{
  "name": "my-plugin",              // 小写字母/数字/连字符（壳的脚手架会校验）
  "version": "0.0.1",
  "private": true,                  // 本地脚手架默认 private；要发布时去掉
  "type": "module",                 // ESM
  "exports": {
    "./entry": "./lib/index.js"     // 给 patch 层引用的入口子路径
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml" // 关键：声明本包是一个 bundle 插件，
                                    // 其 patch 层就是这份 YAML
    }
  },
  "files": ["lib", "cordis.patch.yml"]  // npm 发布时只带这两个
}
```

要点：

- `exports["./entry"]` 与 patch 里的 `name: my-plugin/entry` 对应——patch 层引用「包名 + 子路径」，loader 据此解析到 `lib/index.js`。
- `dsh.bundle.patch` 让 dsh 在 reconcile 时把本包加入 `dsh.profile.bundles`，并把 patch 内容叠加进配置树。
- `files` 决定发布到 npm 的包内容（`lib/` + patch 文件）。

### 3.2 `lib/index.js`（宿主入口，函数插件）

```js
// my-plugin：由 patch 层挂载的宿主侧入口
export const name = 'my-plugin'      // 插件名（日志里显示为 [my-plugin] mounted）

export const inject = []             // 依赖注入声明：需要哪些其他插件提供的服务（空 = 无依赖）

export function apply(ctx) {
  // 挂载时执行。ctx 是插件上下文（服务容器）
  console.log('[my-plugin] mounted') // 壳的管理窗口日志能看到这行 = 挂载成功
  ctx.provide('myPluginGreeting', 'hello from my-plugin')  // 对外提供服务（其他插件可 inject）
  // 更多能力（对应 §0.2 的五个核心概念）：
  // ctx.on('session/event', handler)      —— 监听事件（卸载时自动撤销）
  // ctx.effect(callback)                   —— 注册可逆副作用（reload/teardown 时回滚）
  // ctx.tools.register({...})              —— 注册工具（工具插件的入口）
  // ctx.router.get('/path', handler)       —— 挂 HTTP 路由
}
```

要点：

- `name` / `inject` / `apply` 是 Cordis 函数插件的三个约定导出（上游教程 `cordis-tutorial/01-first-plugin.zh.md` 的开头就是这个最小形态）。
- `inject` 声明「我需要别人提供的服务」；声明后 Cordis 会**等这些服务就绪再调用 `apply`**，加载顺序由依赖关系决定（§0.2 概念 3）。
- `ctx.provide(key, value)` 注册服务，其他插件通过 `inject` 声明后从 `ctx.<key>` 拿到——**按 key 找服务，不 import 具体实现**。
- `apply` 还能收第二个参数 `config`——来自 patch 层该行传入的配置（模板里没传，所以只收 `ctx`）。
- 工具插件、钩子插件、UI 插件的具体写法分别见上游 `adding-a-tool.zh.md`、`extension-cookbook.zh.md`、`adding-a-conversation-node.zh.md`。

### 3.3 `cordis.patch.yml`（分层补丁）

```yaml
# my-plugin patch 层：把入口挂成 web profile 的一行
- insert:
    - id: my-plugin          # 这一行的唯一 id（配置树里可被其他层按 id 引用/覆盖）
      name: my-plugin/entry  # 指向 package.json exports 里的 ./entry
```

要点：

- 语法是上游的 patch 规则（`insert` 插入行）。行有 `id`（稳定标识）和 `name`（要加载的模块）。
- 因为它是 profile 的一层，**用户层的配置可以按 id 覆盖它**；改这个文件属于「配置改动」，HMR 热生效（§4.3）。
- 更复杂的 patch（`update`/`remove`、按路径定位）见上游 cookbook。

### 3.4 在管理窗口里完整走一遍

1. 管理窗口 → 插件管理 → 「新建插件」输入 `my-plugin` → 脚手架生成到 `$DSH_HOME/plugins-local/my-plugin/` 并自动 `file:` 安装 + 重启引擎；
2. 插件列表出现 `my-plugin`（带 bundle 标记）；
3. 引擎日志出现 `[my-plugin] mounted` —— 挂载成功。

---

## 四、端到端开发流程

### 4.1 脚手架

管理窗口 → 插件管理 → 「新建插件」输入名字（小写字母/数字/连字符）→ 模板生成到 `$DSH_HOME/plugins-local/<name>/` 并自动安装（`file:` 链接 + 重启引擎）。模板三件套就是 §3 讲的三件套。

### 4.2 改代码（宿主插件）

改 `lib/index.js` → 管理窗口「重新加载引擎」（或菜单 Cmd/Ctrl+R）→ 看日志确认 `[<name>] mounted`。宿主插件改动**必须重启**才生效（boot 数秒，代价小）。

### 4.3 配置调整（patch HMR）

管理窗口 → 调试工具 → 补丁编辑器改 `cordis.patch.yml`：

- **配置改动 HMR 热生效**（不用重启）——配置 HMR 是配置级的；
- **结构性改动**（增删行/换 id）保存时提示重启，面板一键重启。

> 为什么分两种？配置 HMR 只能把「改动的行」热挂载/热卸载；新增行不一定能热挂载，换了 id 等于换了一个新行——这些属于结构变化，稳妥起见重启（AD-7）。

### 4.4 客户端插件（web UI 组件）

1. 设置里配 checkout 路径（指向上游源码目录）；
2. checkout 里跑 `pnpm run dev:web` 启动前端开发服务器；
3. 改浏览器半代码自动 HMR（client-hmr）。

已知限制（如实告知用户）：热重载丢组件内 React state、失败无回滚。

### 4.5 调试手段（管理窗口 → 调试工具）

| 手段 | 干什么 |
|---|---|
| 实时日志 | stdout+stderr，500 行环形缓冲回放（晚开窗口也能看历史），可清空/导出 |
| 配置树 `--dump-config` + diff | 看装前/装后配置树，确认你的 patch 行在**正确的分层位置**，定位「为什么没生效」 |
| 启动失败自动诊断 | `diagnoseStartupFailure` 模式匹配：指名插件/缺包/pnpm/网络错误 |
| 引擎调试端口 | 设置 → 引擎调试端口 → Chrome DevTools attach `chrome://inspect`（壳只透传 `NODE_OPTIONS`，零侵入） |

### 4.6 验证清单

- 插件列表出现该行（bundle 标记）→
- 引擎日志无报错 + `[<name>] mounted` → 
- 配置树分层正确（`dump-config` diff）→
- web UI 设置页插件清单（Loader 只读投影）可读。

### 4.7 发布

`npm publish`（记得去掉 `private: true`）。用户按包名安装；`dsh plugin` 自动 reconcile，`update` 也能激活「新版本才声明 bundle」的包。

---

## 五、测试与回归（hello-bundle fixture）

仓库 `test/fixtures/hello-bundle/` 是一个最小 bundle 插件 fixture，用来做「壳的插件管线没被上游机制变化打破」的回归测试。流程（`Electron基座应用开发.md` §2.8）：

1. `dsh plugin --profile web add file:<fixture 绝对路径>`；
2. profile manifest 的 bundles 自动 reconcile（`[dsh-base, dsh-web-app, dsh-hello-bundle]`）；
3. 重启引擎 → 日志出现 `[hello-bundle] mounted`；
4. `remove` 后 bundles 恢复原状。

**改插件机制相关代码后必跑这个回归**（检查清单见 `Electron基座应用开发.md` §2.8）。

---

## 六、注意事项与坑（都踩过）

- **本地目录安装必须绝对路径**：上游 `anchorPathSpec` 会把相对路径锚到调用 cwd；`file:` 链接安装后改代码重建即生效（重启引擎）。壳的「新建插件」已用绝对路径，手动装本地目录时注意。
- **git 依赖被 pnpm ≥10 拦 prepare 脚本** → 按提示在 profile 的 `pnpm-workspace.yaml` 配 `allowBuilds`。桌面版插件页已提供「放行并重装」按钮：自动写 `allowBuilds`、重跑 `pnpm install` 与 `add`（2026-09-03 起），等价官方 `pnpm approve-builds --all` 流程。
- **npm 依赖的构建脚本被拦（如 node-pty）**：pnpm ≥10 默认不执行依赖构建脚本（pnpm 11 strict 直接失败、pnpm 10 警告跳过）——桌面版插件页同样可用「放行并重装」一键处理；纯 CLI 则 `cd $DSH_HOME/profiles/web && pnpm approve-builds` 后重跑 `dsh plugin add`。
- **原生依赖**：node-gyp 模块在 Electron 内嵌 Node 下可能需要 `@electron/rebuild`（`pnpm run rebuild-engine` 对 `resources/engine` 全树处理）；**优先用 N-API 免重编**。
- **安全边界**：插件代码与 shell 同权，只装可信来源的插件——这是产品文档和代码注释里都要反复强调的点。
- **patch 行没生效**：先 `dump-config` 看分层位置，再确认 `id` 没有被其他层覆盖（§4.5）。
- **挂了但没日志**：检查是否走了正确的 profile（`--profile web`）；引擎日志面板 500 行缓冲，先确认没被刷掉。
