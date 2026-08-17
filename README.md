# dsh-desktop

Electron 壳，托管 DeepSeek Harness 的 `dsh web` 引擎。业务功能 100% 复用上游原版；引擎以子进程运行在 Electron 内嵌 Node 上（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`）。

## 开发运行

```sh
pnpm install
pnpm run install-engine   # 首次：把锁定版本引擎装进 resources/engine（registry，7 分钟左右）
pnpm dev
```

引擎来源按优先级解析（`src/main/index.ts` 的 `resolveDshBin`）：

1. `DSH_ENGINE_BIN`：显式指定 dsh CLI 入口（调试用），优先级最高；
2. `resources/engine` 打包引擎（`pnpm run install-engine` 安装；发布版默认路径）；
3. `DSH_CHECKOUT`：指向 deepseek-harness 源码目录（使用其已构建的 `apps/cli/lib/bin.js`）；
4. 设置里保存的 checkout 路径（开发模式，管理窗口「设置与更新」页签配置）。

窗口先显示状态壳，健康检查（HTTP 200 + `__DSH_BOOT__` 注入）通过后自动加载原版 web UI；关闭窗口即优雅停引擎（无残留进程）。

## 管理窗口（Cmd/Ctrl + , 或主窗口「管理」按钮）

- **插件管理**：npm / 本地目录 / git 三种安装路径（底层 `dsh plugin --profile web`，装完自动重启引擎）、卸载、更新、打开 profile 目录；
- **调试工具**：引擎日志实时流、配置树（`--dump-config`）与 diff、`cordis.patch.yml` 补丁编辑器（YAML 校验，配置改动 HMR 热生效）；
- **设置与更新**：开发模式 checkout 路径、引擎调试端口（`--inspect`）、引擎版本检查 / `$DSH_HOME` 备份 / 引擎重装。

详见 `docs/使用总结.md`。

## 命令

```sh
pnpm dev              # 编译并启动 Electron 壳
pnpm compile          # 只编译：tsc 编译 main + 拷贝 preload/renderer 到 dist/
pnpm build            # 打包出最终产物：compile + electron-builder（三平台，产物在 release/）
pnpm install-engine   # 安装锁定版本引擎到 resources/engine（registry 主路径，DSH_CHECKOUT 构建兜底）
pnpm rebuild-engine   # @electron/rebuild：引擎原生模块按 Electron ABI 重编
pnpm smoke            # 引擎冒烟：Electron-as-Node boot + 健康检查 + 优雅退出
pnpm typecheck
pnpm lint
```

> ⚠️ 打包命令是 **`pnpm build`**（或 `pnpm run build`）。不要用 `pnpm pack`——那是 pnpm 内置命令（等价 `npm pack`，打 tarball），不会执行本项目的打包脚本。

## 文档

- `docs/implementation-plan.md` — 实施计划与架构决策（AD-1 ~ AD-10，含 Phase 进度）
- `docs/开发总结.md` — 开发总结：仓库结构、核心机制、插件开发与测试调试
- `docs/使用总结.md` — 使用总结：安装、插件、更新、故障排查
