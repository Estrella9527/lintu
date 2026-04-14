import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,
  downloadFile: (url: string, filename: string) =>
    ipcRenderer.invoke('download-file', url, filename) as Promise<string | null>,
  openFile: (path: string) => ipcRenderer.invoke('open-file', path) as Promise<void>,
})
