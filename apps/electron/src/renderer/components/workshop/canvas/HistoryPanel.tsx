import { useMemo, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight, Clock, Loader2, RefreshCw, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { activeProjectIdAtom } from '@/atoms/project'
import { activeModuleAtom } from '@/atoms/navigation'
import {
  canvasObjectsAtom, canvasViewportAtom, isImageObject, isPlaceholderObject,
  selectedObjectIdAtom,
  type CanvasImageObject,
} from '@/atoms/canvas'
import { workshopModeAtom, workshopBatchDialogAtom } from '@/atoms/workshop'
import { api, apiFetchRaw } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { cn } from '@/lib/utils'
import type { ImageRecord } from '@/lib/types'

import { SaveAsStrategyDialog } from './SaveAsStrategyDialog'

interface HistoryPanelProps {
  canvasSnapshot: Record<string, unknown>
  onTransferToBatch: () => void
}

/**
 * 画布右面板 v2 — 「历史记录」+ 选中卡 + 操作页脚。
 *
 * 内容(从上到下):
 *   1. 「当前选中」紧凑卡 — image 显示 thumb+尺寸, placeholder 显示状态(生成中/失败+错误)
 *      没选中时跳过这一区,直接显历史
 *   2. 「最近生成」滚动列表 — 项目内 source_type='generated' 的图,30 张,按 created_at desc
 *      点条目 → 把这张图加到画布(视口中心),让用户可追溯历史成果
 *   3. 底部:加入资产库 / 存为策略
 *
 * 数据源:复用 /api/images?source_type=generated&project_id=... — 后端已有,
 * 我们生成的每张图都自动入了 ImageRecord(source_type='generated'),所以无需新表。
 */
export function HistoryPanel({ canvasSnapshot }: HistoryPanelProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const [objects, setObjects] = useAtom(canvasObjectsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedObjectIdAtom)
  const viewport = useAtomValue(canvasViewportAtom)
  const setMode = useSetAtom(workshopModeAtom)
  const setShowBatch = useSetAtom(workshopBatchDialogAtom)
  const setActiveModule = useSetAtom(activeModuleAtom)
  const [showSave, setShowSave] = useState(false)

  // 当前选中 — 区分 image / placeholder
  const rawSelected = objects.find((o) => o.id === selectedId) || null
  const selectedImage = rawSelected && isImageObject(rawSelected) ? rawSelected : null
  const selectedPlaceholder = rawSelected && isPlaceholderObject(rawSelected) ? rawSelected : null

  // 历史列表 — 项目内 generated 图,按时间倒序前 30 张
  // 每 30s 自动刷新一次,新生成的图会自动出现(不需要手动 refresh)
  const { data, isLoading, refetch, isFetching } = useQuery<{ items: ImageRecord[] }>({
    queryKey: ['canvas-history', projectId],
    queryFn: () => api.images.list({
      project_id: projectId!,
      source_type: 'generated',
      limit: 30,
      offset: 0,
    }) as Promise<{ items: ImageRecord[] }>,
    enabled: !!projectId,
    refetchInterval: 30_000,
  })
  const history = data?.items || []

  // 选中历史条目 → 加进画布(视口中心 + 稍微 stagger)
  // imageOrId 接受 ImageRecord 或裸 id(用于 parent 链 — 我们只有 id)
  const addHistoryToCanvas = (img: ImageRecord | { id: string; width?: number; height?: number }) => {
    const w = (img as any).width || 1024
    const h = (img as any).height || 1024
    const stage = document.querySelector('canvas')
    const stageRect = stage?.getBoundingClientRect()
    const canvasW = stageRect?.width || 1200
    const canvasH = stageRect?.height || 800
    const centerX = (canvasW / 2 - viewport.x) / viewport.scale
    const centerY = (canvasH / 2 - viewport.y) / viewport.scale
    const stagger = (objects.length % 4) * 40
    const newObj: CanvasImageObject = {
      type: 'image',
      id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      image_id: img.id,
      src: api.images.fileUrl(img.id),
      x: centerX - w / 2 + stagger,
      y: centerY - h / 2 + stagger,
      width: w, height: h, rotation: 0, selected: false,
    }
    setObjects((prev) => [...prev, newObj])
    setSelectedId(newObj.id)
  }

  const removeSelected = () => {
    if (!rawSelected) return
    setObjects((prev) => prev.filter((o) => o.id !== rawSelected.id))
    setSelectedId(null)
  }

  const submitToReview = async () => {
    if (!selectedImage) return
    try {
      const res = await apiFetchRaw(`/images/${selectedImage.image_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: 'pending' }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        toast.error(`加入审核队列失败:${text.slice(0, 120)}`)
        return
      }
      toast.success('已加入审核队列', {
        action: { label: '去审核', onClick: () => setActiveModule('review-queue') },
      })
    } catch (e) {
      toast.error(`加入审核队列失败:${(e as Error).message}`)
    }
  }

  return (
    <>
      <aside className="w-[300px] shrink-0 border-l border-foreground/5 bg-background flex flex-col">
        <div className="px-4 py-2.5 h-[40px] border-b border-foreground/5 flex items-center gap-2">
          <Clock size={13} className="text-foreground/55" />
          <h3 className="text-[12.5px] font-medium text-foreground/85">历史记录</h3>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded-md
                       text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground transition-colors
                       disabled:opacity-40 disabled:cursor-wait"
            title="手动刷新历史"
          >
            <RefreshCw size={11} strokeWidth={1.6} className={cn(isFetching && 'animate-spin')} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          {/* 选中状态卡 — 紧凑,不抢戏 */}
          {selectedPlaceholder && (
            <div className={cn(
              'rounded-lg border p-2.5',
              selectedPlaceholder.status === 'pending'
                ? 'border-accent/30 bg-accent/[0.04]'
                : 'border-destructive/30 bg-destructive/[0.04]',
            )}>
              <div className="flex items-center gap-2 text-[11.5px] font-medium">
                {selectedPlaceholder.status === 'pending'
                  ? <><Loader2 size={11} className="animate-spin text-accent" /><span className="text-accent">生成中…</span></>
                  : <span className="text-destructive">生成失败</span>}
                <span className="ml-auto text-[10.5px] text-foreground/45">
                  {selectedPlaceholder.requestType}
                </span>
              </div>
              {selectedPlaceholder.errorMessage && (
                <div className="text-[10.5px] text-destructive/85 mt-1.5 break-all">
                  {selectedPlaceholder.errorMessage}
                </div>
              )}
              <button
                onClick={removeSelected}
                className="mt-2 w-full h-6 rounded-md text-[10.5px] text-foreground/55
                           hover:bg-foreground/[0.05] hover:text-foreground transition-colors
                           inline-flex items-center justify-center gap-1"
              >
                <Trash2 size={10} /> 移除占位
              </button>
            </div>
          )}
          {selectedImage && (
            <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-2 flex gap-2">
              <div className="h-12 w-12 rounded-md overflow-hidden ring-1 ring-foreground/8 shrink-0 bg-foreground/[0.04]">
                <ThumbnailImage imageId={selectedImage.image_id} size={128} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-between">
                <div className="text-[10.5px] text-foreground/45 tabular-nums">
                  {Math.round(selectedImage.width)} × {Math.round(selectedImage.height)}
                </div>
                <button
                  onClick={removeSelected}
                  className="text-[10.5px] text-foreground/55 hover:text-destructive inline-flex items-center gap-1 self-start"
                >
                  <Trash2 size={10} /> 从画布移除
                </button>
              </div>
            </div>
          )}

          {/* 历史列表 */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-foreground/40 font-medium px-1 mb-1.5">
              最近生成({history.length})
            </div>
            {!projectId ? (
              <div className="py-8 text-center text-[11px] text-foreground/40">请先选择项目</div>
            ) : isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-foreground/[0.04] animate-pulse" />
                ))}
              </div>
            ) : history.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-foreground/40 leading-relaxed">
                还没有生成记录 ·
                <br />
                Prompt 栏发起第一次生成吧
              </div>
            ) : (
              <div className="space-y-1.5">
                {history.map((img) => (
                  <HistoryItem
                    key={img.id}
                    img={img}
                    onAddResult={() => addHistoryToCanvas(img)}
                    onAddSource={(parentId) => addHistoryToCanvas({ id: parentId })}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-foreground/5 flex gap-2">
          <Button
            variant="outline" size="sm"
            className="flex-1 h-8 text-[12px]"
            disabled={!selectedImage}
            onClick={() => void submitToReview()}
            title={selectedImage ? '把当前选中对象加入审核队列' : '先选中画布上一张图'}
          >
            加入资产库
          </Button>
          <Button
            size="sm"
            className="flex-1 h-8 text-[12px]"
            onClick={() => setShowSave(true)}
          >
            存为策略
          </Button>
        </div>
      </aside>

      <SaveAsStrategyDialog
        open={showSave}
        onClose={() => setShowSave(false)}
        canvasSnapshot={canvasSnapshot}
        defaultTaskType="custom"
        onSaved={() => {
          toast.success('已存为策略,可去批量策略 mode 立即使用', {
            action: { label: '去批量策略', onClick: () => { setMode('batch'); setShowBatch(true) } },
          })
        }}
      />
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────

/**
 * 历史卡 — 区分 text2img(只显示结果)和图生图类(显示 [源 → 结果] 配对)。
 *
 * 数据来源:img.parent_id 是源图(后端 generate 时已设置)。文生图 parent_id 为 null。
 *
 * 交互:
 *   - 点 result 缩略 → 把结果加到画布
 *   - 点 source 缩略 → 把源图加到画布(方便"再改一次")
 *   - 点 prompt 区(右侧文字) → 加 result 到画布(默认操作)
 */
function HistoryItem({
  img, onAddResult, onAddSource,
}: {
  img: ImageRecord
  onAddResult: () => void
  onAddSource: (parentId: string) => void
}) {
  const meta = img.generation_metadata as Record<string, any> | null | undefined
  const type = (meta?.type as string) || (img.source_type === 'generated' ? 'gen' : 'orig')
  const promptText: string = (meta?.prompt as string) || meta?.prompt_content || ''
  const cost: number | undefined = (meta?.cost_usd as number) || undefined
  const created = img.created_at ? new Date(img.created_at) : null
  const relTime = useMemo(() => formatRelative(created), [created])
  const parentId: string | null = img.parent_id

  return (
    <div
      className="rounded-lg p-1.5 hover:bg-foreground/[0.04] transition-colors
                 ring-1 ring-transparent hover:ring-foreground/8"
      title={promptText || img.file_name}
    >
      <div className="flex gap-2">
        {/* 缩略区 — 有 parent 时:[src] → [result];否则仅 [result] */}
        {parentId ? (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onAddSource(parentId) }}
              title="点击把源图加到画布"
              className="h-12 w-12 rounded-md overflow-hidden ring-1 ring-foreground/15 bg-foreground/[0.04]
                         hover:ring-accent/45 transition-all"
            >
              <ThumbnailImage imageId={parentId} size={128} className="w-full h-full object-cover" />
            </button>
            <ArrowRight size={9} className="text-foreground/35 shrink-0" />
            <button
              onClick={(e) => { e.stopPropagation(); onAddResult() }}
              title="点击把生成结果加到画布"
              className="h-12 w-12 rounded-md overflow-hidden ring-1 ring-foreground/15 bg-foreground/[0.04]
                         hover:ring-accent transition-all"
            >
              <ThumbnailImage imageId={img.id} size={128} className="w-full h-full object-cover" />
            </button>
          </div>
        ) : (
          <button
            onClick={onAddResult}
            title="点击把生成结果加到画布"
            className="h-14 w-14 rounded-md overflow-hidden ring-1 ring-foreground/8 shrink-0
                       bg-foreground/[0.04] hover:ring-accent transition-all"
          >
            <ThumbnailImage imageId={img.id} size={128} className="w-full h-full object-cover" />
          </button>
        )}
        {/* 文字区 — 点也算加结果 */}
        <button
          onClick={onAddResult}
          className="flex-1 min-w-0 flex flex-col justify-between py-0.5 text-left"
        >
          <div className="flex items-start gap-1">
            <span className="text-[10px] font-medium text-accent uppercase tracking-wide shrink-0">
              {labelForType(type)}
            </span>
            {img.width && img.height && (
              <span className="text-[10px] text-foreground/35 tabular-nums shrink-0 ml-auto">
                {img.width}×{img.height}
              </span>
            )}
          </div>
          <div className="text-[11px] text-foreground/75 leading-snug line-clamp-2">
            {promptText || img.file_name}
          </div>
          <div className="flex items-center justify-between text-[10px] text-foreground/40">
            <span>{relTime}</span>
            {typeof cost === 'number' && cost > 0 && (
              <span className="tabular-nums">${cost.toFixed(4)}</span>
            )}
          </div>
        </button>
      </div>
    </div>
  )
}

function labelForType(t: string): string {
  switch (t) {
    case 'text2img': return '文生图'
    case 'img2img':  return '图生图'
    case 'outpaint': return '扩图'
    case 'inpaint':  return '重绘'
    case 'matting':  return '抠图'
    case 'eraser':   return '消除'
    case 'upscale':  return '超分'
    case 'text-zh':  return '中文'
    case 'edit':     return 'Ask AI'
    case 'gen':      return '生成'
    default: return t
  }
}

function formatRelative(d: Date | null): string {
  if (!d) return ''
  const delta = Date.now() - d.getTime()
  if (delta < 60_000)    return '刚刚'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`
  return `${Math.round(delta / 86_400_000)} 天前`
}
