export {}

declare global {
  interface Window {
    electronAPI: {
      platform: string
      selectDirectory: () => Promise<string | null>
      downloadFile: (url: string, filename: string) => Promise<string | null>
      saveFileToPath: (url: string, absolutePath: string) => Promise<string | null>
      openFile: (path: string) => Promise<void>
      /** 把 URL 指向的图片写入系统剪贴板(位图) */
      clipboardWriteImage: (url: string) => Promise<boolean>
      onSidecarLifecycle: (
        cb: (event: 'restarting' | 'ready', payload: { reason?: string; ok?: boolean }) => void,
      ) => () => void
    }
  }
}
