/**
 * electron-builder 动态配置（`pnpm build` 通过 --config 显式加载）。
 *
 * 为什么需要 JS：electron-builder 只对 publish 等特定字段做 ${env.X} 宏展开，
 * `mac.identity` 不会展开（实测展开成了字面量 "${env.CSC_IDENTITY}"，导致
 * 身份名不存在 → 构建静默变成未签名）。签名身份必须在 JS 里按环境计算：
 *
 *   - 配置了证书（CSC_NAME 非空）：由 scripts/make-self-signed-cert.mjs 写入
 *     .env.local，或 CI 通过 secret 注入。identity 置空字符串 → 证书身份由
 *     CSC_NAME 显式指定（配合 CSC_LINK / CSC_KEY_PASSWORD；共享 .env 关闭了
 *     自动发现 CSC_IDENTITY_AUTO_DISCOVERY=false，不会误用钥匙串里其它证书）。
 *     注意：证书必须先被本机信任（脚本自动做；CI 工作流有对应步骤），否则
 *     electron-builder 的 `security find-identity -v` 找不到它 → 未签名。
 *   - 未配置证书：identity = '-' → ad-hoc 签名（与引入签名前的行为一致）。
 * @module dsh-desktop/electron-builder.config
 */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { load } = require('js-yaml')

const base = load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'))
base.mac = { ...base.mac, identity: process.env.CSC_NAME ? '' : '-' }
module.exports = base
