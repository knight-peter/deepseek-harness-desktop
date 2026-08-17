/**
 * Clipboard capabilities for the shell: a change watcher (Electron's
 * `clipboard` module has no change event, so we poll) and permission
 * plumbing so the engine UI can use the async Clipboard API.
 *
 * Two independent fixes live here:
 *  1. `ClipboardWatcher` — polls the system clipboard and reports text
 *     changes. This is the "listen to the clipboard" primitive; the shell
 *     broadcasts changes to all windows over IPC.
 *  2. `allowClipboardPermissions` — the engine UI is a local web app; its
 *     input bar pastes through the sync DOM `paste` event (no permission
 *     needed), but other UI paths use `navigator.clipboard.readText()` /
 *     `writeText()`, which Chromium gates behind the `clipboard-read` and
 *     `clipboard-sanitized-write` permissions. Without a handler Electron
 *     denies those for http origins, so we explicitly allow them.
 *
 * NOTE on the root cause this module pairs with: on macOS, Cmd+C/V/X/A are
 * routed through the application menu's Edit roles. dsh-desktop's custom
 * menu originally had no Edit menu, which silently killed copy/paste
 * shortcuts app-wide. The Edit menu lives in `index.ts`; this module covers
 * everything else.
 * @module dsh-desktop/clipboard
 */

import { clipboard, type Session } from 'electron'

export interface ClipboardWatcherOptions {
  /** Called with the new plain-text content whenever the clipboard changes. */
  onTextChange(text: string): void
  /** Poll interval in ms (default 800). */
  intervalMs?: number
}

/**
 * Poll the system clipboard for text changes. Electron exposes no clipboard
 * change event; polling `clipboard.readText()` is the standard approach and
 * is cheap (a few KB of text). Only text is tracked — images/files are
 * out of scope for the paste-into-dsh use case.
 */
export class ClipboardWatcher {
  private timer: NodeJS.Timeout | null = null
  private lastText = ''
  private readonly intervalMs: number
  private readonly onTextChange: (text: string) => void

  constructor(options: ClipboardWatcherOptions) {
    this.onTextChange = options.onTextChange
    this.intervalMs = options.intervalMs ?? 800
  }

  /** Start polling (idempotent). */
  start(): void {
    if (this.timer !== null) return
    this.lastText = clipboard.readText()
    this.timer = setInterval(() => {
      const text = clipboard.readText()
      if (text !== this.lastText) {
        this.lastText = text
        this.onTextChange(text)
      }
    }, this.intervalMs)
  }

  /** Stop polling (idempotent). */
  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * Allow the engine UI (and the shell pages) to use the async Clipboard API.
 * Electron's default is to grant permission requests, but once a handler is
 * installed it must answer every request; we answer `true` for everything so
 * behaviour stays permissive and `clipboard-read` / `clipboard-sanitized-write`
 * (which Chromium otherwise denies on http origins) work for the engine page.
 */
export function allowClipboardPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    void _webContents
    void _permission
    callback(true)
  })
  session.setPermissionCheckHandler((_webContents, _permission) => {
    void _webContents
    void _permission
    return true
  })
}

/** Insert a string into the focused editable element of the focused window. */
export function pasteTextToFocusedWindow(getFocusedWindow: () => Electron.BrowserWindow | null, text: string): boolean {
  const win = getFocusedWindow()
  if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) return false
  win.webContents.insertText(text)
  return true
}
