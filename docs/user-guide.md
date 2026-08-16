# dsh-desktop 用户指南

dsh-desktop 是 DeepSeek Harness 的 Electron 桌面壳：窗口里是原版 `dsh web` 界面，引擎作为子进程运行在 Electron 内嵌 Node 上。所有数据仍在 `$DSH_HOME`（默认 `~/.dsh`），与 `dsh` CLI 完全共享。

## 启动

```sh
pnpm install
pnpm dev
```

窗口先显示状态壳（「引擎启动中…」），健康检查通过后自动加载原版 web UI。关闭窗口即停止引擎（SIGTERM → 等待 → 强杀，无残留进程）。

### 引擎来源（按优先级）

1. `DSH_ENGINE_BIN` 环境变量：显式指定 dsh CLI 入口（调试用）；
2. `resources/engine` 打包引擎（`pnpm run install-engine` 安装，发布版默认路径）；
3. `DSH_CHECKOUT` 环境变量：deepseek-harness 源码目录（使用其已构建的 `apps/cli/lib/bin.js`）；
4. 设置里保存的 checkout 路径（开发模式，见下）。

## 管理窗口（Cmd/Ctrl + ,）

主窗口右上角「管理」按钮或菜单「窗口 → 管理窗口」打开，三个页签：

### 插件管理

- 已安装列表：模板 bundle（dsh-base、dsh-web-app）、用户 bundle、普通依赖；
- **新建插件**：输入名字 → 生成模板到 `$DSH_HOME/plugins-local/<name>/`（`dsh.bundle` 声明 + 函数插件入口 + patch 层）并自动安装；
- 安装：npm 包 / 本地目录（绝对路径，`file:` 链接）/ git 仓库；底层是上游 `dsh plugin --profile web add`（pnpm 安装 + bundles 自动 reconcile），装完自动重启引擎；
- 卸载 / 更新同理；git 依赖若被 pnpm 拦截 prepare 脚本，按提示在 profile 的 `pnpm-workspace.yaml` 配 `allowBuilds`。

### 调试工具

- 引擎日志实时流（含 stderr；环形缓冲回放最近 500 行，可清空/导出）；
- 配置树（`--dump-config`）与「与上次对比」diff，定位插件分层位置；
- 启动失败自动诊断：解析引擎 stderr，给出「插件 X 加载失败 / 缺包 / pnpm 失败 / 网络错误」等友好提示；
- 补丁编辑器：profile 级 / home 级 `cordis.patch.yml`，保存前 YAML 校验（容忍 `!!js` 表达式）；配置改动 HMR 热生效，结构性改动（增删行）提示重启引擎。

引擎崩溃时窗口会自动回到状态壳显示错误与日志（不会自动重启，防死循环）。

### 设置与更新

- 开发模式 checkout 路径（仅开发版生效；引擎来源优先级见上）；
- 引擎调试端口（`NODE_OPTIONS=--inspect=<port>`，Chrome DevTools attach）；
- 引擎版本检查、`$DSH_HOME` 备份、引擎重装（`install-engine`）。

## 更新

- 引擎：管理窗口「应用引擎更新」→ 重装 `resources/engine`（锁定版本，npm registry）→ 重启引擎。**升级前先「备份 $DSH_HOME」**（预发布期格式不承诺兼容，`SESSION_FORMAT_VERSION=0`）。
- 应用壳：发布版菜单「检查应用更新」（electron-updater，GitHub Releases）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 窗口停在「待机」，弹「未找到 dsh 引擎」 | 按上面引擎来源配置其一（发布版先 `pnpm run install-engine`） |
| 启动失败弹错误卡片并指名插件 | 引擎 stderr 会点名 unresolved 插件；卸载/修正后重启；壳不会自动重启（防死循环） |
| 页面白屏 | 健康检查含 `__DSH_BOOT__` 断言，连错服务会报错而非白屏；确认 3080 上旧实例已停 |
| 装 git 插件失败 | pnpm ≥10 拦 prepare 脚本：profile 的 `pnpm-workspace.yaml` 配 `allowBuilds` |
| 想断点调试引擎 | 设置里开「引擎调试端口」，Chrome DevTools attach `chrome://inspect` |
| 日志在哪 | 管理窗口「调试工具」实时日志；或终端里 `pnpm dev` 的 stdout（`[engine:*]` 前缀） |
