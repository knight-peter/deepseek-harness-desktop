// Copy non-compiled assets (sandboxed CJS preload, plain renderer) into dist/
// after tsc emits the main process. tsc only emits TS; these are shipped as-is.
import { cpSync, mkdirSync } from 'node:fs'

for (const dir of ['preload', 'renderer']) {
  mkdirSync(`dist/${dir}`, { recursive: true })
  cpSync(`src/${dir}`, `dist/${dir}`, { recursive: true })
}
console.log('copy-static: preload + renderer copied to dist/')
