# dsh-desktop

Electron 壳，托管 DeepSeek Harness 的 `dsh web` 引擎。业务功能 100% 复用上游原版；引擎以子进程运行在 Electron 内嵌 Node 上（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`）。

## 开发运行

```sh
mise install                # 首次：按 mise.toml 装 Node 24 + pnpm 11（可选，已装对应版本可跳过）
cp .env .env.local  # 可选：本机私有凭据——.env 底部有私有项模板（复制到 .env.local 填），共享配置已在 .env，build/publish 按 .env → .env.development → .env.local 顺序加载（dev 不读）
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
pnpm build            # 打包出最终产物：compile + electron-builder（本机当前架构，Intel Mac → x64）
pnpm run publish-x64  # 把本机 x64 产物上传到指定 GitHub release 并合并 latest-mac.yml（用法见下文）
pnpm run release      # 自动累加版本号 + commit + tag + push，触发发布流程（用法见下文）
pnpm install-engine   # 安装锁定版本引擎到 resources/engine（registry 主路径，DSH_CHECKOUT 构建兜底）
pnpm rebuild-engine   # @electron/rebuild：引擎原生模块按 Electron ABI 重编
pnpm smoke            # 引擎冒烟：Electron-as-Node boot + 健康检查 + 优雅退出
pnpm typecheck
pnpm lint
```

> ⚠️ 打包命令是 **`pnpm build`**（或 `pnpm run build`）。不要用 `pnpm pack`——那是 pnpm 内置命令（等价 `npm pack`，打 tarball），不会执行本项目的打包脚本。

## 发布到 GitHub Releases

mac 双架构策略：**CI（macos-15）出 arm64 包，本机出 x64 包**，两者通过 `scripts/publish-x64.mjs` 合并进同一个 GitHub release（electron-updater 按机器架构自动选包）。

**CI 只在打 `v*` tag 时触发**（workflow `on.push.tags`）；普通 push 不跑 CI。发布流程：打 tag → CI 三平台打包并建 release → 本机 Intel x64 补发。

### 前置条件

- `.env.local` 里已填 `GH_TOKEN`（fine-grained，仓库权限 Contents: Read and write）；
- 工作区干净（bump-version 会拒绝 dirty 状态）。

### 流程（一条命令自动累加版本号）

```sh
# 1. 自动累加版本 + commit + tag + push（触发 CI 三平台构建 + 自动建 release）
pnpm run release                    # v0.1.0 → v0.1.1（默认 patch）
pnpm run release -- --minor         # → v0.2.0（可选）
pnpm run release -- --major         # → v1.0.0（可选）
pnpm run release -- --version 0.3.0 # 显式指定（可选）

# 2. 等 CI 全绿，确认 GitHub Releases 里已有该 tag 的 release

# 3. 本机打 Intel x64 包（本机 Mac）
pnpm build

# 4. 上传 x64 dmg/zip 到该 release 并合并 latest-mac.yml
#    --tag 可省略：自动探测最新 v* tag（即 release 刚生成的版本）
pnpm run publish-x64               # 自动用最新 tag
pnpm run publish-x64 -- --tag v0.1.1  # 或显式指定
```

`bump-version`（`pnpm run release`）自动完成：读最新 `v*` tag → 累加 patch/minor/major → 更新 `package.json` version → commit（`release: vX.Y.Z`）→ 打 tag → 推送（触发 CI）。

`publish-x64` 自动完成：计算本地 x64 产物的 sha512/size → 以 `-x64` 后缀名上传（`dsh-desktop-<版本>-x64.dmg` / `-x64-mac.zip`，electron-updater 靠文件名区分架构）→ 拉取 release 里已有的 `latest-mac.yml`（arm64 条目）→ 合并 x64 条目后覆盖上传 → **校验 release 多平台完整性**（mac x64+arm64 / windows / linux / 更新元数据，缺失会警告）。

> `--tag` 缺省时自动取最新 `v*` tag（与 release 刚生成的版本一致）；显式传 `--tag` 可覆盖。当前产物未签名/未公证（默认不签名策略），用户安装会弹系统警告，适合自测与内部使用；正式分发需配置 Developer ID 证书 + 公证凭据。

## 文档

- `docs/implementation-plan.md` — 实施计划与架构决策（AD-1 ~ AD-10，含 Phase 进度）
- `docs/开发总结.md` — 开发总结：仓库结构、核心机制、插件开发与测试调试
- `docs/使用总结.md` — 使用总结：安装、插件、更新、故障排查
