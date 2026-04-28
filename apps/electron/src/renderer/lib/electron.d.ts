export {}

declare global {
  interface Window {
    electronAPI: {
      platform: string
      selectDirectory: () => Promise<string | null>
      downloadFile: (url: string, filename: string) => Promise<string | null>
      saveFileToPath: (url: string, absolutePath: string) => Promise<string | null>
      openFile: (path: string) => Promise<void>
      onSidecarLifecycle: (
        cb: (event: 'restarting' | 'ready', payload: { reason?: string; ok?: boolean }) => void,
      ) => () => void
    }
  }
}
