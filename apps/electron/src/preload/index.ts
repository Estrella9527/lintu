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
