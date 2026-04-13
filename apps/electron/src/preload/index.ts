import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  selectDirectory: () => ipcRenderer.invoke('select-directory') as Promise<string | null>,
})
