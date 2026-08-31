/**
 * Create a self-signed macOS code-signing certificate (.p12) for the
 * "路线一" (route 1) update signing setup, and wire it into the local build
 * via `.env.local` (CSC_LINK / CSC_KEY_PASSWORD).
 *
 * Why a stable self-signed certificate fixes macOS auto-update:
 * Squirrel.Mac validates that an update is signed with the SAME signing
 * identity as the installed build. Ad-hoc signing (`identity: "-"`) gives
 * every build a random identity (designated requirement = cdhash), so Squirrel
 * always rejects the next version. Signing every release with one persistent
 * .p12 makes the requirement stable and Squirrel accepts the update on ANY
 * Mac — no Apple Developer Program membership needed. Trade-offs (Gatekeeper
 * right-click → Open on first launch of a freshly downloaded copy) and the
 * paid Developer ID + notarization alternative are documented in README.md.
 *
 * Outputs (all under `release/`, which is gitignored — never commit the
 * private key):
 *   - release/keys/dsh-release.p12          the certificate + private key
 *   - release/keys/dsh-release.p12.pass     the .p12 export password
 *   - .env.local                            CSC_LINK / CSC_KEY_PASSWORD lines
 *
 * The SAME .p12 must sign every release from now on (including the first
 * version users install); see README for CI (arm64) setup.
 * @module dsh-desktop/make-self-signed-cert
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function fail(message) {
  console.error(`make-self-signed-cert: ${message}`)
  process.exit(1)
}

function run(cmd, args, { silent = false } = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.error !== undefined) fail(`cannot run ${cmd}: ${result.error.message}`)
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} exited ${String(result.status)}: ${(result.stderr ?? result.stdout ?? '').trim().slice(-500)}`)
  }
  if (!silent) process.stdout.write(result.stdout ?? '')
  return (result.stdout ?? '').trim()
}

function parseArgs(argv) {
  const args = { name: 'dsh-desktop-release', days: 3650, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force') args.force = true
    else if (arg === '--name') args.name = argv[++i] ?? fail('--name needs a value')
    else if (arg === '--days') args.days = Number(argv[++i]) || 3650
    else fail(`unknown argument: ${arg}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const keysDir = join(ROOT, 'release', 'keys')
const p12Path = join(keysDir, 'dsh-release.p12')
const passPath = join(keysDir, 'dsh-release.p12.pass')
const envPath = join(ROOT, '.env.local')

if (existsSync(p12Path) && !args.force) {
  console.log(`make-self-signed-cert: ${p12Path} 已存在（跳过；用 --force 重新生成，注意会作废之前所有用旧证书签的版本）`)
  process.exit(0)
}

run('openssl', ['version'])
mkdirSync(keysDir, { recursive: true })

const password = run('openssl', ['rand', '-base64', '24'], { silent: true }).trim()
const csrPath = join(keysDir, 'dsh-release.csr')
const keyPath = join(keysDir, 'dsh-release.key')
const certPath = join(keysDir, 'dsh-release.crt')

console.log(`make-self-signed-cert: 生成自签名代码签名证书 CN=${args.name}（有效期 ${args.days} 天）…`)

run('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(args.days),
  '-keyout', keyPath, '-out', certPath,
  '-subj', `/CN=${args.name}`,
  '-addext', 'basicConstraints=critical,CA:FALSE',
  '-addext', 'keyUsage=critical,digitalSignature',
  '-addext', 'extendedKeyUsage=codeSigning',
])

// Export the certificate + private key as PKCS#12; the password below becomes
// CSC_KEY_PASSWORD. `-name` sets the keychain item label (the signing
// identity) — keep it identical to the CN so `security find-identity` and
// electron-builder agree on the name.
run('openssl', [
  'pkcs12', '-export',
  '-out', p12Path, '-inkey', keyPath, '-in', certPath,
  '-passout', `pass:${password}`,
  '-name', args.name,
])

writeFileSync(passPath, `${password}\n`)
chmodSync(passPath, 0o600)
// The key material is the signing identity itself: keep it out of git and
// restrict read access (the .p12 embeds the private key).
chmodSync(p12Path, 0o600)
// 公开证书保留一份（非机密），用于信任与文档；密钥文件删除。
writeFileSync(certPath, run('openssl', ['pkcs12', '-in', p12Path, '-passin', `pass:${password}`, '-nokeys', '-clcerts'], { silent: true }))
rmSync(csrPath, { force: true })
rmSync(keyPath, { force: true })

// 把证书加入「用户域信任」：electron-builder 的身份发现走
// `security find-identity -v`，不受信任的自签名证书会被过滤（0 valid
// identities），构建会变成未签名。信任后即可被发现并签名。
// 注意：自签名证书信任为根（trustRoot）即可；撤销：security remove-trusted-cert -d <cert>。
console.log('make-self-signed-cert: 把证书加入用户域信任（构建机需要，CI 有单独步骤）…')
{
  const trustResult = spawnSync('security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', `${process.env.HOME}/Library/Keychains/login.keychain-db`, certPath], { encoding: 'utf8' })
  if (trustResult.status !== 0) {
    // 信任失败不阻塞：证书/构建配置仍已就绪，用户可手动信任（或后续构建时发现）。
    console.warn(`make-self-signed-cert: 信任证书失败（${(trustResult.stderr ?? '').trim().slice(-200)}）——如需自动更新请手动信任或重试`)
  } else {
    console.log('make-self-signed-cert: 已信任 ✓')
  }
}

// Wire into the local build (pnpm build already loads .env.local via
// `--env-file-if-exists`). CSC_NAME 是签名身份的开关：electron-builder.config.cjs
// 根据它把 identity 置空（证书模式）或 '-'（ad-hoc）。CSC_IDENTITY_AUTO_DISCOVERY
// 保持共享 .env 的 false——不误用钥匙串里其它证书，身份完全由 CSC_NAME 指定。
function upsertEnv(envPath, key, value) {
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : []
  const re = new RegExp(`^${key}=`)
  const index = lines.findIndex((line) => re.test(line) && !line.trimStart().startsWith('#'))
  if (index >= 0) {
    lines[index] = `${key}=${value}`
  } else {
    lines.push(`${key}=${value}`)
  }
  writeFileSync(envPath, `${lines.join('\n')}\n`)
}

upsertEnv(envPath, 'CSC_LINK', p12Path)
upsertEnv(envPath, 'CSC_KEY_PASSWORD', password)
upsertEnv(envPath, 'CSC_NAME', args.name)
console.log(`make-self-signed-cert: 已写入 ${envPath}`)

console.log(`
make-self-signed-cert: 完成 ✅
  证书（含私钥，勿提交 git）: ${p12Path}
  导出密码:                ${passPath}
  签名身份名:              ${args.name}

下一步：
  1. 本地 mac 构建（pnpm build）现在会用该证书签名（.env.local 已写入
     CSC_LINK/CSC_KEY_PASSWORD/CSC_NAME，identity 由
     electron-builder.config.cjs 动态选择）。
  2. arm64 CI 构建也要用同一证书，否则 Apple Silicon 机器上的自动更新仍会失败：
     把 p12 内容 base64 后设为 GitHub secret DSH_MAC_CSC_LINK，密码设为
     DSH_MAC_CSC_KEY_PASSWORD（.github/workflows/build.yml 已支持）。
  3. 以后每个版本都必须用这同一个 .p12 签名——换证书 = 已装版本校验更新失败。
`)
