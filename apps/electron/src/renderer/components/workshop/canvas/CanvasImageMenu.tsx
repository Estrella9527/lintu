import { useEffect, useRef } from 'react'
import { Copy, Download, FolderPlus, PenTool } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'

export interface CanvasImageMenuState {
  /** 屏幕坐标(clientX/Y),菜单 position:fixed 直接用 */
  x: number
  y: number
  imageId: string
}

/**
 * 画布图片右键菜单 — 保存原图 / 复制图片 / 加入资产库。
 *
 * 用 fixed 定位贴着鼠标弹出;点外部 / Esc / 滚轮 关闭。
 * 复制走主进程剪贴板(nativeImage),外部应用可直接粘贴位图;
 * 保存走已有 downloadFile IPC(系统保存框)。
 */
export function CanvasImageMenu({
  menu, onClose,
}: {
  menu: CanvasImageMenuState
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // mousedown 用 capture,在画布 stopPropagation 之前就能收到
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    document.addEventListener('wheel', onClose, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  const saveOriginal = async () => {
    onClose()
    try {
      // 取 file_name 作为保存框默认名;拿不到就用 id 兜底
      let filename = `${menu.imageId}.jpg`
      try {
        const rec = await api.images.get(menu.imageId)
        if (rec?.file_name) filename = rec.file_name
      } catch { /* 默认名兜底 */ }
      const saved = await window.electronAPI.downloadFile(
        api.images.downloadUrl(menu.imageId), filename,
      )
      if (saved) toast.success('原图已保存', { description: saved })
    } catch (e) {
      toast.error(`保存失败:${(e as Error).message}`)
    }
  }

  const copyImage = async () => {
    onClose()
    try {
      const ok = await window.electronAPI.clipboardWriteImage(
        api.images.fileUrl(menu.imageId),
      )
      if (ok) toast.success('图片已复制,可在外部应用直接粘贴')
      else toast.error('复制失败:图片读取异常')
    } catch (e) {
      toast.error(`复制失败:${(e as Error).message}`)
    }
  }

  const exportSvg = async () => {
    onClose()
    try {
      let stem = menu.imageId
      try {
        const rec = await api.images.get(menu.imageId)
        if (rec?.file_name) stem = rec.file_name.replace(/\.[^.]+$/, '')
      } catch { /* 默认名兜底 */ }
      toast.message('正在矢量化…', { description: '首次转换需要几秒,完成后弹出保存框' })
      const saved = await window.electronAPI.downloadFile(
        api.images.svgUrl(menu.imageId), `${stem}.svg`,
      )
      if (saved) toast.success('SVG 已导出', { description: saved })
    } catch (e) {
      toast.error(`导出失败:${(e as Error).message}`)
    }
  }

  const addToLibrary = async () => {
    onClose()
    try {
      await api.images.setLibrary([menu.imageId], true)
      toast.success('已加入资产库')
    } catch (e) {
      toast.error(`加入资产库失败:${(e as Error).message}`)
    }
  }

  const itemCls =
    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] text-foreground/80 ' +
    'hover:bg-foreground/[0.05] hover:text-foreground transition-colors text-left'

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[148px] rounded-lg border border-foreground/8
                 bg-background/98 backdrop-blur-md p-1
                 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
      // 不让菜单超出视口右/下缘
      style={{
        left: Math.min(menu.x, window.innerWidth - 168),
        top: Math.min(menu.y, window.innerHeight - 170),
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className={itemCls} onClick={copyImage}>
        <Copy size={13} className="text-foreground/55" /> 复制图片
      </button>
      <button className={itemCls} onClick={saveOriginal}>
        <Download size={13} className="text-foreground/55" /> 保存原图
      </button>
      <button className={itemCls} onClick={exportSvg} title="位图转矢量;适合 logo/插画/海报元素,照片会变色块风格">
        <PenTool size={13} className="text-foreground/55" /> 导出 SVG(矢量)
      </button>
      <div className="my-1 h-px bg-foreground/8" />
      <button className={itemCls} onClick={addToLibrary}>
        <FolderPlus size={13} className="text-foreground/55" /> 加入资产库
      </button>
    </div>
  )
}
