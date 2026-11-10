# Third-Party Notices

dsh-desktop redistributes the following third-party components inside its
installers. License texts ship with the components at the locations noted
(inside the app bundle under `Contents/Resources/`).

## Electron

- **Electron** — MIT License. https://github.com/electron/electron
  (also see `LICENSES.chromium.html` inside the Electron distribution)

## Engine dependencies (npm, `Resources/engine/`)

- **LibreOffice** (via `@deepseek-ai/libreoffice-kit-*`) — **MPL-2.0**.
  License texts: `engine/node_modules/@deepseek-ai/libreoffice-kit-*/licenses/`
  (`LibreOffice-MPL-2.0.txt`, `LibreOffice-third-party.html`).
  https://www.libreoffice.org/
- Other npm packages ship under their own licenses (MIT/BSD/Apache-2.0/…);
  see each package's `LICENSE` file inside `engine/node_modules/`.

## Office primary-runtime payload (`Resources/runtime/primary-runtime/`)

Built by `scripts/prepare-primary-runtime.mjs` from
`scripts/primary-runtime.lock.json` (pinned URLs + SHA-256).

- **CPython 3.12.14** (astral-sh/python-build-standalone) — **PSF-2.0**.
  https://github.com/astral-sh/python-build-standalone
- **Python wheels** (into `dependencies/python/lib/python3.12/site-packages/`):

  | Package | Version | License |
  |---|---|---|
  | numpy | 2.3.5 | BSD-3-Clause |
  | pandas | 3.0.1 | BSD-3-Clause |
  | Pillow | 12.3.0 | MIT-CMU (HPND) |
  | lxml | 6.1.3 | BSD-3-Clause |
  | python-docx | 1.2.0 | MIT |
  | python-pptx | 1.0.2 | MIT |
  | openpyxl | 3.1.5 | MIT |
  | XlsxWriter | 3.2.9 | BSD-2-Clause |
  | python-dateutil | 2.9.0.post0 | Apache-2.0 / BSD-3-Clause (dual) |
  | six | 1.17.0 | MIT |
  | tzdata | 2025.2 | Apache-2.0 |
  | typing_extensions | 4.16.0 | PSF-2.0 |
  | et_xmlfile | 2.0.0 | MIT |

  Each wheel's license text ships in its `*.dist-info/` directory.

- **Office skills assets** (`Resources/runtime/office-skills/`) — copied from
  `@deepseek-ai/dsh-skill-office` (MIT), part of the upstream
  [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) project
  (MIT License, Copyright (c) 2026 DeepSeek).

## Build-time only (NOT redistributed)

- `scripts/prepare-primary-runtime.mjs` and `scripts/primary-runtime-smoke.py`
  are ports/copies of MIT-licensed upstream files from deepseek-harness
  (`scripts/primary-runtime/prepare.ts`, `lock.json`, `smoke.py`,
  upstream commit 37983d9298, 2026-09-18). They run at build time and are not
  shipped in the installers.
- In the default **python-only** payload mode, **no Node.js runtime is
  bundled**. The optional `--full` mode additionally bundles Node.js (MIT,
  https://nodejs.org/) and pnpm (MIT, https://pnpm.io/).
