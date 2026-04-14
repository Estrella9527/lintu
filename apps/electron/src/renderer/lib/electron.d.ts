export {}

declare global {
  interface Window {
    electronAPI: {
      platform: string
      selectDirectory: () => Promise<string | null>
      downloadFile: (url: string, filename: string) => Promise<string | null>
      openFile: (path: string) => Promise<void>
    }
  }
}
