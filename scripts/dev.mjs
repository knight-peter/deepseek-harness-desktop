// Dev launcher: `electron .` equivalent that first receives the layered env
// files from the invoking `node --env-file-if-exists=…` (see package.json
// `dev` script), so runtime switches like DSH_DESKTOP_USER_DATA /
// DSH_DESKTOP_OPEN_MANAGER live in `.env*` files (team: .env.development;
// machine-private: .env.local / .env.development.local) instead of being
// typed on the command line every time.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

// ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node — the
// main process's ESM `import { … } from 'electron'` then fails with
// "does not provide an export named …" (it resolves the npm `electron`
// package instead of the builtin). Hosts that run Electron under
// ELECTRON_RUN_AS_NODE (e.g. the dsh-desktop engine parent) export it to
// every child, so a dev shell inheriting it would break `pnpm dev`; strip it
// before spawning the real GUI binary.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [process.cwd()], {
  stdio: 'inherit',
  env,
  windowsHide: false,
})

child.on('error', (error) => {
  console.error('[dev] spawn electron failed:', error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
