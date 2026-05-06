import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,
  downloadFile: (url: string, filename: string) =>
    ipcRenderer.invoke('download-file', url, filename) as Promise<string | null>,
  /** Bulk save: writes URL bytes to an absolute path with NO save dialog.
   * Callers must pick the directory themselves (via selectDirectory). */
  saveFileToPath: (url: string, absolutePath: string) =>
    ipcRenderer.invoke('save-file-to-path', url, absolutePath) as Promise<string | null>,
  openFile: (path: string) => ipcRenderer.invoke('open-file', path) as Promise<void>,
  /** Subscribe to dev-mode sidecar restart lifecycle. Returns an unsubscribe. */
  onSidecarLifecycle: (cb: (event: 'restarting' | 'ready', payload: any) => void) => {
    const r = (_e: any, p: any) => cb('restarting', p)
    const k = (_e: any, p: any) => cb('ready', p)
    ipcRenderer.on('lintu:sidecar-restarting', r)
    ipcRenderer.on('lintu:sidecar-ready', k)
    return () => {
      ipcRenderer.removeListener('lintu:sidecar-restarting', r)
      ipcRenderer.removeListener('lintu:sidecar-ready', k)
    }
  },
})

// Auto-update bridge. Renderer listens for lifecycle events and triggers
// manual checks / restarts via these APIs. See main/index.ts for the
// boot sequence; the renderer normally only needs `on('downloaded')` to
// surface a "restart now" toast.
type UpdaterEvent =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'progress'
  | 'downloaded'
  | 'error'

contextBridge.exposeInMainWorld('updaterAPI', {
  /** Current installed version (read from electron's app.getVersion(), which
   *  is sourced from package.json at build time). */
  getVersion: () => ipcRenderer.invoke('app:get-version') as Promise<string>,
  /** Trigger a manual check (Settings → 关于 → 检查更新 button). */
  check: () =>
    ipcRenderer.invoke('updater:check') as Promise<
      { ok: true; version?: string } | { ok: false; reason: string }
    >,
  /** Restart the app and apply the staged update. Requires that `downloaded`
   *  has already fired. */
  quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  /** Subscribe to updater lifecycle. Returns an unsubscribe function. */
  on: (event: UpdaterEvent, cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload)
    ipcRenderer.on(`updater:${event}`, handler)
    return () => ipcRenderer.removeListener(`updater:${event}`, handler)
  },
})
