# dsh-desktop

DeepSeek Harness（dsh）的 **Electron 桌面版**：窗口里是原版 `dsh web` 界面，引擎作为子进程运行在应用自带的 Electron 内嵌 Node 上——**无需安装 Node / pnpm**，开箱即用。所有数据（会话、设置、凭据、插件）与命令行 `dsh` 完全共享（默认 `~/.dsh`）。

## 安装（macOS）

App 目前为 **ad-hoc 签名、未公证**（尚未配置 Apple Developer ID 证书）：从网上下载后首次打开，系统会提示「无法验证开发者」——这是正常现象，**右键 App →「打开」→ 确认**即可运行。推荐用一键安装脚本（自动下载对应架构 + 去除隔离标记 + 装到应用程序，全程无拦截）：

```sh
# 安装最新版（自动识别 Apple Silicon / Intel 并下载对应包）
curl -fsSL https://raw.githubusercontent.com/knight-peter/deepseek-harness-desktop/main/scripts/install-mac.sh | bash

# 指定版本（可选）
curl -fsSL https://raw.githubusercontent.com/knight-peter/deepseek-harness-desktop/main/scripts/install-mac.sh | bash -s 0.1.1
```

手动安装：到 [GitHub Releases](https://github.com/knight-peter/deepseek-harness-desktop/releases) 下载 `dsh-desktop-<版本>-arm64.dmg`（Apple Silicon）或 `-x64.dmg`（Intel），拖进「应用程序」后右键 → 打开。遇到「已损坏，无法打开」提示时（旧包或下载被截断）：`xattr -cr /Applications/dsh-desktop.app` 后再打开。

**Windows / Linux**：用 GitHub Releases 里对应平台的安装包（NSIS 安装器 / AppImage）。

## 功能速览

- **主窗口**：原版 `dsh web` 全部功能（对话、工具、设置等），启动后自动加载；关闭窗口即优雅停止引擎，无残留进程。
- **管理窗口**（`Cmd/Ctrl + ,` 或主窗口「管理」按钮）：插件管理（npm / 本地目录 / git 安装、新建插件、卸载更新）、调试工具（引擎日志、配置树与 diff、补丁编辑器）、设置与更新（引擎版本/备份/重装、应用更新）。
- **更新**：引擎更新（升级 dsh 本体，升级前自动备份数据）+ 应用更新（GitHub Releases + GitCode 国内镜像双源，自动下载、重启安装）。

更多使用细节（安装插件、更新、故障排查、卸载）见 **[`docs/使用总结.md`](docs/使用总结.md)**。

## 开发运行

```sh
mise install              # 首次：按 mise.toml 装 Node 24 + pnpm 11（可选）
cp .env .env.local        # 可选：本机私有凭据模板（token 等），见 .env 底部注释
pnpm install
pnpm run install-engine   # 首次：把锁定版本引擎装进 resources/engine（registry，约 7 分钟）
pnpm dev                  # 编译并启动（引擎从 resources/engine 或 DSH_CHECKOUT 解析）
```

常用命令：`pnpm build`（打包当前平台产物到 `release/`）、`pnpm run typecheck` / `lint` / `smoke`、`pnpm run release`（发布入口，见下）。完整命令表、环境分层、踩坑记录见 **[`docs/Electron基座应用开发.md`](docs/Electron基座应用开发.md)**（第二章开发工作流、第三章打包全流程）。

> ⚠️ 打包命令是 **`pnpm build`**（或 `pnpm run build`）。不要用 `pnpm pack`——那是 pnpm 内置命令（等价 `npm pack`，打 tarball），不会执行本项目的打包脚本。

## 发布流程（速览）

发新版本 = **打 tag 推 GitHub → CI 三平台打包 → 本机补 mac 包 → 本机同步 GitCode 镜像**：

```sh
pnpm run release-all                # 一键全流程：bump+tag+push → 等 CI → 本机构建 →
                                    # 发布（Intel 机自动合并 x64）→ 下载产物 → GitCode 镜像
                                    # 可选：--minor / --major / --version x.y.z / --skip-build / --skip-mirror / --skip <平台> / --dry-run
```

分步（需要手动盯 CI 或跳过某步时用）：
```sh
pnpm run release                    # 唯一可显式带版本号的命令（可选 --minor/--major/--version x.y.z）；
                                    # 默认自动累加版本 + commit + tag + push，触发 CI

# CI 全绿后（release 是 draft，需发布为公开）：
pnpm run publish-release         # 默认：只把 CI 建的 draft release 发布为公开（任何机器）
pnpm build && pnpm run publish-release --with-x64  # Intel Mac 本机：补发 x64 包并合并进 release，再发布

pnpm run download-release           # 用 gh CLI 下载 GitHub release 全平台产物（完整镜像前置）；
                                    # 本机打过包的平台用 --skip 复用本地副本（如 --skip mac-x64），不传则全量下载
pnpm run sync-domestic --dir release/mirror   # 上传到 GitCode 国内镜像（自动跳过旧版本残留）
```

版本号唯一来源是 `package.json` 的 `version`（tag 恒为 `v<version>`）：除 `release` / `release-all` 可用 `--version` 显式指定外，其余命令都不带版本参数，自动读取。**完整发布流程、命令详解、签名/公证、GitCode 镜像、环境坑见 [`docs/发布总结.md`](docs/发布总结.md)**。

## 文档

- **[`docs/使用总结.md`](docs/使用总结.md)** — 使用总结：安装、界面、插件、更新、故障排查（终端用户）
- **[`docs/发布总结.md`](docs/发布总结.md)** — 发布总结：发版全流程、命令详解、GitCode 镜像、环境坑（发版操作者）
- **[`docs/Electron基座应用开发.md`](docs/Electron基座应用开发.md)** — Electron 基座开发：Electron 基础、引擎托管、打包、更新（开发者）
- **[`docs/dsh插件开发.md`](docs/dsh插件开发.md)** — dsh 插件开发：三类插件、模板逐行讲解、调试与发布（插件作者）
