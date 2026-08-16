# dsh-desktop 插件作者指南

插件的加载、注册、分层、HMR 全部由上游 deepseek-harness 实现（Cordis 插件树）。本壳只负责「装、卸、重启、观察」。先读上游文档：`docs/cookbook/adding-a-package.md` 与 `docs/cookbook/extension-cookbook.md`。

## 插件类型

| 类型 | 声明 | 生效 |
|---|---|---|
| **宿主插件**（工具/服务/事件） | 普通 npm 包，入口被 loader 挂载 | 代码改动需重启引擎（boot 数秒） |
| **bundle 插件**（分层补丁） | `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | 安装后自动进入 profile 的 bundles 分层；patch 行可再被用户层覆盖 |
| **客户端插件**（web UI） | `package.json` 声明 `dsh.client`，bundle 有浏览器半 | 自动进入 `__DSH_BOOT__` 图谱；开发模式（checkout + `pnpm run dev:web`）可 HMR |

## 脚手架

最小 bundle 插件：

```
my-plugin/
├─ package.json          # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }, "exports": {"./entry": "./lib/index.js"}
├─ cordis.patch.yml      # 插入行（id/name/config）
└─ lib/index.js          # 函数插件：export const name / inject / Config / apply
```

`cordis.patch.yml` 示例：

```yaml
- insert:
    - id: my-plugin
      name: my-plugin/entry
      config:
        greeting: hi
```

入口示例（宿主侧，Node 进程内）：

```js
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx, config) {
  ctx.on('ready', () => console.log('[my-plugin] mounted'))
}
```

客户端插件（UI 组件）按上游 cookbook 的「Chat nodes / 客户端包」规范写，浏览器半会由 `dsh.client` 声明自动进图谱。

## 本地开发循环

1. 把插件源码放在任意目录（建议 `$DSH_HOME/plugins-local/<name>/`）；
2. 管理窗口 → 插件管理 → 「本地目录」→ 填绝对路径 → 安装（`file:` 链接，自动重启引擎）；
3. 宿主插件：改代码 → 重建（tsdown/tsc）→ 「重新加载引擎」→ 管理窗口日志观察；
4. 客户端插件：开发模式（设置里配 checkout 路径 + checkout 内跑 `pnpm run dev:web`）下自动 HMR；
5. 配置类调整：管理窗口「调试工具」直接改 `cordis.patch.yml`（HMR 热生效，无需重启）。

## 验证

- 管理窗口 → 插件管理：行已出现（bundle 标记）；
- 管理窗口 → 调试工具 → 配置树：确认行在正确的分层位置（装前/装后 diff）；
- 管理窗口 → 引擎日志：无报错；挂载日志可见；
- 设置页（web UI 内）插件清单：Loader 条目只读投影。

## 发布

`npm publish`（包名带 scope 或普通名均可）。用户在你的插件包 `dsh.bundle` 声明齐全后，管理窗口直接按包名安装；`dsh plugin` 会自动 reconcile 分层，`update` 也能激活「新版本才声明 bundle」的包。

## 注意

- 安装后重启引擎是壳的策略（web profile 的 HMR 是配置级的，新行不一定能热挂载）；
- 插件代码在引擎进程内运行，与 shell 同权（等于本机 shell 权限）；只装可信来源的插件；
- 原生依赖（node-gyp）在 Electron 内嵌 Node 下可能需 `@electron/rebuild`（`pnpm run rebuild-engine` 对 `resources/engine` 全树处理）；优先用 N-API。
