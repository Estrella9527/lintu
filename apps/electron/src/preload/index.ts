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
  /** Distribution flavor — 'dev' / 'user' / 'ops'. Renderer uses this to
   *  show 用户版/运营版 badges and adapt safety messaging. */
  getBuildFlavor: () => ipcRenderer.invoke('app:get-build-flavor') as Promise<'dev' | 'user' | 'ops'>,
  /** 云端同步凭据 IPC — 让 dev / ops 用户从 UI 配 sync URL + token。
   *  User flavor 总是返回 reason='user_flavor_locked'。 */
  cloudSyncCreds: {
    get: () =>
      ipcRenderer.invoke('cloud-sync-creds:get') as Promise<{
        available: boolean
        has_creds: boolean
        reason?: string
        url?: string | null
        token_set?: boolean
      }>,
    set: (url: string, token: string) =>
      ipcRenderer.invoke('cloud-sync-creds:set', { url, token }) as Promise<{
        ok: boolean
        reason?: string
      }>,
    clear: () =>
      ipcRenderer.invoke('cloud-sync-creds:clear') as Promise<{ ok: boolean; reason?: string }>,
  },
  /** 让 main 重启 sidecar 子进程（凭据改完后调一下让新 env 生效） */
  restartSidecar: () =>
    ipcRenderer.invoke('sidecar:restart') as Promise<{ ok: boolean; error?: string }>,

  /** 登录 token 加密存储 — safeStorage 落盘 / 读出 / 清空。
   *  登录成功后 set；每次 fetch 取出挂 Authorization；登出清空。
   *  同 cloud-sync-creds 保护级别（OS keychain 加密）。 */
  authToken: {
    get: () => ipcRenderer.invoke('auth-token:get') as Promise<string | null>,
    set: (token: string) =>
      ipcRenderer.invoke('auth-token:set', token) as Promise<{ ok: boolean; reason?: string }>,
    clear: () =>
      ipcRenderer.invoke('auth-token:clear') as Promise<{ ok: boolean }>,
  },
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
