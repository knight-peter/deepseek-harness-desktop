# dsh-desktop

Electron 壳，托管 DeepSeek Harness 的 `dsh web` 引擎。业务功能 100% 复用上游原版；引擎以子进程运行在 Electron 内嵌 Node 上（`ELECTRON_RUN_AS_NODE=1`）。

## 开发运行

```sh
pnpm install
pnpm dev
```

引擎来源按优先级解析（`src/main/index.ts` 的 `resolveDshBin`）：

1. `DSH_ENGINE_BIN`：显式指定 dsh CLI 入口（调试用），优先级最高；
2. `resources/engine` 打包引擎（Phase 2 实现 `scripts/install-engine.ts` 后）；
3. `DSH_CHECKOUT`：指向 deepseek-harness 源码目录（使用其已构建的 `apps/cli/lib/bin.js`）；
4. **开发模式自动探测**：本仓库与 `deepseek-harness` 互为兄弟目录时（如 `~/Learn/` 下），`pnpm dev` 裸跑即可工作。

发布模式：`resources/engine` 下安装 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-web-frontend`（见 `docs/implementation-plan.md` §3.3，Phase 2 实现 `scripts/install-engine.ts`）。

## 命令

```sh
pnpm dev         # 构建并启动 Electron 壳
pnpm build       # tsc 编译 main + 拷贝 preload/renderer 到 dist/
pnpm typecheck
pnpm lint
pnpm pack        # 构建 + electron-builder 三平台打包
```

## 文档

- `docs/implementation-plan.md` — 实施计划与架构决策（AD-1 ~ AD-10）
