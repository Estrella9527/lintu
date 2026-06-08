import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 监听容器上的 drag-drop + 文档级 paste,把图片文件抽出来交给 onFiles。
 *
 * 设计要点:
 *   - **拖拽** 走容器局部 ref:dragenter/dragover/dragleave/drop。如果你把
 *     dropRef 接到了 document.body / 整页容器,效果就是"整页接受拖入"。
 *   - **粘贴** 走文档级监听:用户在哪里 focus 无所谓,只要 hook 被挂载就
 *     接 clipboard。这跟拖拽的局部性不同 — paste 是 app-wide 行为。
 *   - **isDragging** 状态驱动 overlay 显示/隐藏。dragleave 会在拖过子元素
 *     时误触发,所以用 enter 计数器(`_dragDepth`)抵消假离开。
 *   - **enabled=false** 时全部 listener 短路 — 让你按场景禁用(比如登录页)
 *     不影响别处。
 *
 * 不在这里做的事:
 *   - 文件大小 / 张数限制 — 由后端 50MB / 30 张 兜底,前端只做 MIME 过滤
 *   - 上传本身 — 抛给 useUploadImages 这个 mutation hook
 */
export interface UseImageDropPasteOptions {
  /** 容器 ref;不传 = 不接拖拽(只接 paste) */
  dropRef?: React.RefObject<HTMLElement | null>
  /** 拿到 File[] 后做什么 */
  onFiles: (files: File[]) => void
  /** 整套开关,false 时 hook 不挂任何 listener */
  enabled?: boolean
  /** paste 的全局监听是否开。默认 true。某些纯拖拽场景可以单关 paste */
  enablePaste?: boolean
}

function pickImages(items: DataTransferItem[] | DataTransferItemList | null | undefined): File[] {
  if (!items) return []
  const out: File[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'file') continue
    if (!it.type || !it.type.startsWith('image/')) continue
    const f = it.getAsFile()
    if (f) out.push(f)
  }
  return out
}

export function useImageDropPaste(opts: UseImageDropPasteOptions): { isDragging: boolean } {
  const { dropRef, onFiles, enabled = true, enablePaste = true } = opts
  const [isDragging, setDragging] = useState(false)
  // dragenter/leave 在穿越子元素时成对触发,我们累加深度避免误关 overlay
  const depthRef = useRef(0)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  // 拖拽 — 局部容器
  useEffect(() => {
    if (!enabled) return
    const el = dropRef?.current
    if (!el) return

    const onEnter = (e: DragEvent) => {
      // 只在 dataTransfer 里确实有文件时才进入"拖拽态",避免选文本拖动也触发
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
      e.preventDefault()
      depthRef.current += 1
      if (depthRef.current === 1) setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
      e.preventDefault()
      // 显式声明 copy 才会让 OS 把拖拽光标变成 + 而不是禁止符号
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = () => {
      depthRef.current -= 1
      if (depthRef.current <= 0) {
        depthRef.current = 0
        setDragging(false)
      }
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depthRef.current = 0
      setDragging(false)
      const files = pickImages(e.dataTransfer?.items) || []
      // 兜底:某些情况 items 没拿到但 files 拿得到(老浏览器路径)
      const fallback = !files.length && e.dataTransfer?.files
        ? Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
        : []
      const out = files.length ? files : fallback
      if (out.length) onFilesRef.current(out)
    }

    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragenter', onEnter)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [dropRef, enabled])

  // 粘贴 — 文档级
  useEffect(() => {
    if (!enabled || !enablePaste) return
    const onPaste = (e: ClipboardEvent) => {
      // 在输入框里 ctrl+v 也会冒泡到 document — 让原生先处理,不要抢走
      // 输入框的"粘贴文本"。我们只在 clipboard 里有图、并且 target 不是
      // input/textarea/contenteditable 时才接管。
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (target.isContentEditable) return
      }
      const files = pickImages(e.clipboardData?.items)
      if (files.length) {
        e.preventDefault()
        onFilesRef.current(files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [enabled, enablePaste])

  return { isDragging }
}

/**
 * 给宿主用的小帮手:把 File 转 base64 data URL — 主要给头像 / Logo 那种
 * 不走上传 endpoint,直接落 config 的场景用。
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** 给 onFiles 用的简单版选择器:从 paste 事件里直接挑第一张图。 */
export function firstImageFromPaste(e: ClipboardEvent): File | null {
  return pickImages(e.clipboardData?.items)[0] ?? null
}
