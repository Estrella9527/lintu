import { useMemo, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight, ChevronDown, ChevronRight, Clock, Loader2, PanelRightClose, RefreshCw, Trash2,
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
  // 历史记录默认收起 —— 整块区域留给自由画布,需要时点开为右侧悬浮抽屉。
  const [open, setOpen] = useState(false)

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
      // 拉多一点图,聚合成「操作」后行数会显著少于图数,保证仍能看到足够多次操作
      limit: 80,
      offset: 0,
    }) as Promise<{ items: ImageRecord[] }>,
    enabled: !!projectId,
    refetchInterval: 30_000,
  })
  const history = data?.items || []

  // 按「生成操作」聚合:同一次生成(count=N)的 N 张图,落库 created_at 精确到
  // 微秒几乎相同(同一次提交),且共享 type / 源图 / prompt。以「类型|源图|
  // prompt|秒」为键聚合,一次操作只展示一条(代表图=该次第一张),带 ×N 角标。
  const operations = useMemo(() => groupByOperation(history), [history])

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
      // 加入资产库:置 in_library=True(后端会把原本不在库的图入队推 OSS)。
      // 进库后即出现在「资产库」,可继续走审核 / 上架参与 UGC。
      await api.images.setLibrary([selectedImage.image_id], true)
      toast.success('已加入资产库', {
        action: { label: '去资产库', onClick: () => setActiveModule('asset-library') },
      })
    } catch (e) {
      toast.error(`加入资产库失败:${(e as Error).message}`)
    }
  }

  return (
    <>
      {/* 收起态:右上角悬浮按钮 */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="absolute top-3 right-3 z-30 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                     border border-foreground/10 bg-background/95 backdrop-blur
                     shadow-[0_2px_10px_rgba(0,0,0,0.06)]
                     text-[12px] text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground transition-colors"
          title="展开历史记录"
        >
          <Clock size={13} className="text-foreground/55" />
          历史记录
          {history.length > 0 && (
            <span className="rounded-full bg-accent/12 text-accent text-[10px] px-1.5 py-0.5 tabular-nums leading-none">
              {history.length}
            </span>
          )}
        </button>
      )}

      {/* 展开态:右侧悬浮抽屉(叠在画布上,不占画布栏位) */}
      {open && (
      <aside className="absolute top-0 right-0 bottom-0 w-[320px] z-30 border-l border-foreground/8
                        bg-background/97 backdrop-blur shadow-[-8px_0_24px_rgba(0,0,0,0.08)] flex flex-col">
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
          <button
            onClick={() => setOpen(false)}
            className="h-6 w-6 inline-flex items-center justify-center rounded-md
                       text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
            title="收起历史记录"
          >
            <PanelRightClose size={13} strokeWidth={1.6} />
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

          {/* 历史列表 —— 按「生成操作」聚合:一次生成(不论几张)折叠成一条 */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-foreground/40 font-medium px-1 mb-1.5">
              最近生成({operations.length})
            </div>
            {!projectId ? (
              <div className="py-8 text-center text-[11px] text-foreground/40">请先选择项目</div>
            ) : isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-lg bg-foreground/[0.04] animate-pulse" />
                ))}
              </div>
            ) : operations.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-foreground/40 leading-relaxed">
                还没有生成记录 ·
                <br />
                Prompt 栏发起第一次生成吧
              </div>
            ) : (
              <div className="space-y-1.5">
                {operations.map((op) => (
                  <HistoryItem
                    key={op.rep.id}
                    op={op}
                    onAddImage={(img) => addHistoryToCanvas(img)}
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
      )}

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
/** 把生成图按「同一次操作」聚合。键 = 类型|源图|prompt|秒级时间。
 *  history 已按 created_at 倒序,同次的图相邻,聚合后保持时间序。
 *  返回每组的全部候选(all),供展开逐张挑选。 */
export interface HistoryOp { rep: ImageRecord; all: ImageRecord[] }
function groupByOperation(items: ImageRecord[]): HistoryOp[] {
  const groups: { key: string; all: ImageRecord[] }[] = []
  const idxByKey = new Map<string, number>()
  for (const img of items) {
    const meta = img.generation_metadata as Record<string, any> | null | undefined
    const type = (meta?.type as string) || img.source_type || ''
    const prompt = (meta?.prompt as string) || meta?.prompt_content || ''
    const sec = (img.created_at || '').slice(0, 19)  // 截到秒,丢掉微秒
    const key = `${type}|${img.parent_id || ''}|${prompt}|${sec}`
    const at = idxByKey.get(key)
    if (at != null) {
      groups[at].all.push(img)
    } else {
      idxByKey.set(key, groups.length)
      groups.push({ key, all: [img] })
    }
  }
  return groups.map((g) => ({ rep: g.all[0], all: g.all }))
}

function HistoryItem({
  op, onAddImage, onAddSource,
}: {
  op: HistoryOp
  onAddImage: (img: ImageRecord) => void
  onAddSource: (parentId: string) => void
}) {
  const { rep, all } = op
  const count = all.length
  const [expanded, setExpanded] = useState(false)

  const meta = rep.generation_metadata as Record<string, any> | null | undefined
  const type = (meta?.type as string) || (rep.source_type === 'generated' ? 'gen' : 'orig')
  const promptText: string = (meta?.prompt as string) || meta?.prompt_content || ''
  const cost: number | undefined = (meta?.cost_usd as number) || undefined
  const created = rep.created_at ? new Date(rep.created_at) : null
  const relTime = useMemo(() => formatRelative(created), [created])
  const parentId: string | null = rep.parent_id

  return (
    <div
      className="rounded-lg p-1.5 hover:bg-foreground/[0.04] transition-colors
                 ring-1 ring-transparent hover:ring-foreground/8"
      title={promptText || rep.file_name}
    >
      <div className="flex gap-2">
        {/* 缩略区 — 有 parent 时:[src] → [代表结果];否则仅 [代表结果] */}
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
              onClick={(e) => { e.stopPropagation(); onAddImage(rep) }}
              title="点击把这张结果加到画布"
              className="h-12 w-12 rounded-md overflow-hidden ring-1 ring-foreground/15 bg-foreground/[0.04]
                         hover:ring-accent transition-all"
            >
              <ThumbnailImage imageId={rep.id} size={128} className="w-full h-full object-cover" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => onAddImage(rep)}
            title="点击把这张结果加到画布"
            className="h-14 w-14 rounded-md overflow-hidden ring-1 ring-foreground/8 shrink-0
                       bg-foreground/[0.04] hover:ring-accent transition-all"
          >
            <ThumbnailImage imageId={rep.id} size={128} className="w-full h-full object-cover" />
          </button>
        )}
        {/* 文字区 — 点也算加代表结果(div,避免按钮嵌套) */}
        <div
          onClick={() => onAddImage(rep)}
          className="flex-1 min-w-0 flex flex-col justify-between py-0.5 text-left cursor-pointer"
        >
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-medium text-accent uppercase tracking-wide shrink-0">
              {labelForType(type)}
            </span>
            {count > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
                className="inline-flex items-center gap-0.5 text-[9px] leading-none px-1 py-0.5 rounded
                           bg-accent/12 text-accent shrink-0 tabular-nums hover:bg-accent/20 transition-colors"
                title={expanded ? '收起候选' : `展开这次生成的全部 ${count} 张候选,逐张挑选`}
              >
                ×{count}
                {expanded ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
              </button>
            )}
            {rep.width && rep.height && (
              <span className="text-[10px] text-foreground/35 tabular-nums shrink-0 ml-auto">
                {rep.width}×{rep.height}
              </span>
            )}
          </div>
          <div className="text-[11px] text-foreground/75 leading-snug line-clamp-2">
            {promptText || rep.file_name}
          </div>
          <div className="flex items-center justify-between text-[10px] text-foreground/40">
            <span>{relTime}</span>
            {typeof cost === 'number' && cost > 0 && (
              <span className="tabular-nums">${cost.toFixed(4)}</span>
            )}
          </div>
        </div>
      </div>

      {/* 展开:这次生成的全部候选,逐张点选加到画布 */}
      {expanded && count > 1 && (
        <div className="mt-2 pt-2 border-t border-foreground/8 grid grid-cols-4 gap-1.5">
          {all.map((c, i) => (
            <button
              key={c.id}
              onClick={(e) => { e.stopPropagation(); onAddImage(c) }}
              title={`候选 ${i + 1} / ${count} · 点击加到画布`}
              className="relative aspect-square rounded-md overflow-hidden ring-1 ring-foreground/12
                         bg-foreground/[0.04] hover:ring-accent transition-all group"
            >
              <ThumbnailImage imageId={c.id} size={128} className="w-full h-full object-cover" />
              <span className="absolute bottom-0.5 right-0.5 text-[8px] leading-none px-1 py-0.5 rounded
                               bg-black/55 text-white/90 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
                {i + 1}
              </span>
            </button>
          ))}
        </div>
      )}
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
