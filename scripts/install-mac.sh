#!/usr/bin/env bash
#
# dsh-desktop — macOS 一键安装脚本（免 Developer ID 证书的官方绕行方案）
#
# 作用：从 GitHub Release 下载对应架构的包 → 解压 → 去掉 com.apple.quarantine
# 隔离标记（绕过 Gatekeeper 的「已损坏」拦截）→ 安装到 /Applications → 启动。
#
# 用法：
#   bash scripts/install-mac.sh               # 最新 release，自动识别架构
#   bash scripts/install-mac.sh 0.1.1         # 指定版本（0.1.1 或 v0.1.1 均可）
#   curl -fsSL <raw URL>/scripts/install-mac.sh | bash          # 远端一行安装
#   curl -fsSL <raw URL>/scripts/install-mac.sh | bash -s 0.1.1 # 指定版本
#
# 可选环境变量（镜像源）：
#   DSH_INSTALL_BASE    下载基础地址，默认 https://github.com/knight-peter/deepseek-harness-desktop/releases
#   DSH_INSTALL_RELEASE download 路径里的 release 段，默认 v<版本>；
#                       国内 GitCode 镜像固定为 latest，例如：
#   DSH_INSTALL_BASE=https://gitcode.com/knight-peter/deepseek-harness-desktop/releases \
#   DSH_INSTALL_RELEASE=latest bash scripts/install-mac.sh
#
set -euo pipefail

OWNER=knight-peter
REPO=deepseek-harness-desktop
APP_NAME=dsh-desktop
BASE="${DSH_INSTALL_BASE:-https://github.com/${OWNER}/${REPO}/releases}"

# ── 1. 架构 ──────────────────────────────────────────────────────────────────
case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "install-mac: 不支持的架构 $(uname -m)（仅支持 Apple Silicon / Intel）" >&2; exit 1 ;;
esac

# ── 2. 版本（缺省取 GitHub latest release 的 tag）────────────────────────────
VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(
    curl -fsSL --max-time 30 "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' \
      | head -n 1
  )" || true
  if [[ -z "${VERSION}" ]]; then
    echo "install-mac: 无法获取最新版本号（网络不通或镜像不支持），请显式指定版本：bash install-mac.sh 0.1.1" >&2
    exit 1
  fi
  echo "install-mac: 最新版本 ${VERSION}"
fi
VERSION="${VERSION#v}"                 # 去掉可能的 v 前缀
RELEASE="${DSH_INSTALL_RELEASE:-v${VERSION}}"
ASSET="dsh-desktop-${VERSION}-${ARCH}-mac.zip"
URL="${BASE}/download/${RELEASE}/${ASSET}"

# ── 3. 下载 + 解压 ───────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-install.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

echo "install-mac: 下载 ${URL}（约 200 MB，请耐心等待）..."
curl -fL --retry 3 --max-time 1200 -o "${TMP}/app.zip" "${URL}"

echo "install-mac: 解压..."
ditto -x -k "${TMP}/app.zip" "${TMP}/unpacked"
APP="$(find "${TMP}/unpacked" -maxdepth 2 -name "*.app" -print -quit)"
if [[ -z "${APP}" ]]; then
  echo "install-mac: 压缩包内未找到 .app，中止" >&2
  exit 1
fi

# ── 4. 去隔离标记（核心：绕过 Gatekeeper 的「已损坏」拦截）────────────────────
echo "install-mac: 移除隔离标记（com.apple.quarantine）..."
xattr -cr "${APP}"

# ── 5. 安装到 /Applications ──────────────────────────────────────────────────
DEST="/Applications/${APP_NAME}.app"
if [[ -d "${DEST}" ]]; then
  echo "install-mac: 退出正在运行的旧版本并替换 ${DEST} ..."
  pkill -x "${APP_NAME}" 2>/dev/null || true
  rm -rf "${DEST}"
fi
echo "install-mac: 安装到 ${DEST} ..."
ditto "${APP}" "${DEST}"
xattr -cr "${DEST}"          # 拷贝后再清一次，确保没有隔离标记残留

# ── 6. 启动 ──────────────────────────────────────────────────────────────────
echo "install-mac: 启动 ${APP_NAME} ..."
open "${DEST}"
echo "install-mac: 完成。若系统仍拦截，请右键 ${APP_NAME}.app →「打开」→ 确认一次。"
