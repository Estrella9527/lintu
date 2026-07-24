import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { apiFetchRaw } from '@/lib/api'
import type { ImageRecord } from '@/lib/types'

interface UploadResponseChunk {
  ok: boolean
  uploaded: number
  skipped_duplicates: number
  /** 同 hash 已存在的图(可能此次拖入的就是它们的副本)。
   *  调用方应把这部分图也当作"用户选中"以避免拖完看不到任何反馈。 */
  duplicate_images?: ImageRecord[]
  skipped_invalid: Array<{ name: string; reason: string }>
  images: ImageRecord[]
  compression_task_id?: string | null
}

export interface UploadResult {
  /** 真正新写入数据库的图 */
  images: ImageRecord[]
  uploaded: number
  /** 命中"已存在"那条路径的图 — 没新写,但也应展示给用户(被自动选中) */
  duplicate_images: ImageRecord[]
  skipped_duplicates: number
  skipped_invalid: Array<{ name: string; reason: string }>
  /** 网络/服务端异常而没有完成本地落盘的原始 File；调用方应保留它们供用户重试。 */
  failedFiles: File[]
}

export interface UseUploadImagesOptions {
  /** 上传归属项目;不传时从 onMissingProject 兜底报错 */
  projectId: string | null
  /** 上传成功(整体或单批)后回调,方便宿主刷新列表 / 自动选中等 */
  onSuccess?: (result: UploadResult) => void
  /** 是否直接进资产库。资产库页上传 = true(默认);AI 工坊画布拖入 = false
   *  (只作画布草稿,不进资产库列表、不推 OSS,需手动「上传到图库」)。 */
  inLibrary?: boolean
}

/**
 * 并发上传:把 File[] 分批每批 ≤ N 张,并发 ≤ 4 路 POST /api/images/upload。
 *
 * 为什么不一次性 POST 全部:
 *   - 后端单请求上限 30 张,前端先按 30 分批
 *   - 多并发 = 进度反馈更及时,toast 能滚动告诉用户"已完成 X / Y"
 *   - 单批失败不影响其他批(retry 单批就够)
 *
 * 每个成功落库的资产图库分块，后端会立即排队生成压缩发布版；压缩完成后自动
 * 交给 OSS 同步。画布草稿(inLibrary=false)仍只保存在本地，绝不触发 OSS。
 */
const CHUNK_SIZE = 30
const CONCURRENCY = 4

export function useUploadImages(opts: UseUploadImagesOptions) {
  const { projectId, onSuccess, inLibrary = true } = opts
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  // 防止用户连点上传时 UI state 被旧批次踩;每次上传开新的 toast id
  const toastIdRef = useRef<string | number | null>(null)

  const upload = useCallback(async (files: File[]): Promise<UploadResult | null> => {
    if (!projectId) {
      toast.error('请先选择一个项目再上传图片')
      return null
    }
    const list = files.filter((f) => f.type.startsWith('image/'))
    if (!list.length) {
      // 比如用户拖了一个 zip / pdf 进来
      toast.message('没有可上传的图片', { description: '只接受 image/* 格式' })
      return null
    }

    setUploading(true)
    setProgress({ done: 0, total: list.length })

    // 进度 toast 全程沿用一个 id,持续更新文案
    toastIdRef.current = toast.loading(`上传中 0 / ${list.length}`)

    const chunks: File[][] = []
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      chunks.push(list.slice(i, i + CHUNK_SIZE))
    }

    const aggregate: UploadResult = {
      images: [],
      duplicate_images: [],
      uploaded: 0,
      skipped_duplicates: 0,
      skipped_invalid: [],
      failedFiles: [],
    }

    // 自己实现的轻量级 concurrency 池 — 不引外部依赖
    let cursor = 0
    let doneFiles = 0
    let firstError: Error | null = null

    async function worker() {
      while (true) {
        const idx = cursor++
        if (idx >= chunks.length) return
        const chunk = chunks[idx]
        try {
          const form = new FormData()
          form.append('project_id', projectId!)
          form.append('in_library', String(inLibrary))
          for (const f of chunk) {
            // 客户端没法保证文件名唯一(同截图重复粘贴),后端按 hash 命名落盘,
            // 不会真冲突 — 这里把 filename 传过去只是给后端在 UI / log 里有名字。
            form.append('files', f, f.name || 'image.png')
          }
          // 注意:不能手动设 Content-Type,浏览器要自己加 boundary
          const res = await apiFetchRaw('/images/upload', { method: 'POST', body: form })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
          }
          const data: UploadResponseChunk = await res.json()
          aggregate.images.push(...(data.images || []))
          aggregate.uploaded += data.uploaded || 0
          aggregate.skipped_duplicates += data.skipped_duplicates || 0
          if (data.duplicate_images?.length) {
            aggregate.duplicate_images.push(...data.duplicate_images)
          }
          if (data.skipped_invalid?.length) {
            aggregate.skipped_invalid.push(...data.skipped_invalid)
          }
        } catch (e) {
          firstError = firstError || (e as Error)
          // 单批失败仍把该批所有文件算进 done(进度条不卡住),但其他批继续。
          // 关键是把原始 File 交回宿主保留在上传面板，不能让用户以为失败的
          // 文件已经被保存或悄悄丢失了。
          aggregate.failedFiles.push(...chunk)
        } finally {
          doneFiles += chunk.length
          setProgress({ done: doneFiles, total: list.length })
          if (toastIdRef.current != null) {
            toast.loading(`上传中 ${doneFiles} / ${list.length}`, { id: toastIdRef.current })
          }
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))

    } finally {
      setUploading(false)
      const id = toastIdRef.current
      toastIdRef.current = null
      if (firstError) {
        // TS 在 closure 里赋值的 let 变量,narrow 完会把它降级成 never;
        // 上面 truthy 检查已经排除 null,这里用非空断言告诉 TS"信我".
        const err = firstError as Error
        const msg = `上传部分失败：${err.message}；${aggregate.failedFiles.length} 张仍保留，可直接重试`
        if (id != null) toast.error(msg, { id })
        else toast.error(msg)
      } else {
        // 文案差异:
        // - 全是新图 → "已上传 N 张"
        // - 全是已有 → "N 张已在资产库,直接选中即可"(让用户知道不是失败)
        // - 混合 → 拆开说
        const parts: string[] = []
        if (aggregate.uploaded) parts.push(inLibrary ? `已入图库 ${aggregate.uploaded} 张` : `已保存草稿 ${aggregate.uploaded} 张`)
        if (aggregate.skipped_duplicates) parts.push(`${aggregate.skipped_duplicates} 张${inLibrary ? '已在图库' : '已存在'}`)
        if (aggregate.skipped_invalid.length) parts.push(`拒绝 ${aggregate.skipped_invalid.length} 张`)
        const text = parts.length ? `上传完成：${parts.join(' · ')}` : '没有可上传的图'
        if (id != null) toast.success(text, { id })
        else toast.success(text)
      }
    }

    // 只要至少有一张图(新或已有)成功落地 / 命中,就把整个结果回调给宿主,
    // 让它有机会做"自动选中"等后续动作。原来只在 uploaded > 0 时触发,
    // 导致拖了张已有的图时宿主拿不到任何信号,UI 一动不动。
    if (aggregate.uploaded > 0 || aggregate.duplicate_images.length > 0) {
      onSuccess?.(aggregate)
    }
    return aggregate
  }, [projectId, onSuccess, inLibrary])

  return { upload, uploading, progress }
}
