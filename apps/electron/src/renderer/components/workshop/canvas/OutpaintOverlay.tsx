import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface OutpaintOverlayProps {
  /** 选中对象在画布坐标系里的 bounds(也是原图位置,不变) */
  sourceBounds: { x: number; y: number; width: number; height: number }
  /** Viewport — 把画布坐标转 DOM 坐标 */
  viewport: { scale: number; x: number; y: number }
  busy: boolean
  /** 用户点取消或 Esc */
  onCancel: () => void
  /** 用户点生成,确定的 target_w / target_h / align */
  onSubmit: (params: {
    targetW: number; targetH: number
    alignX: 'left' | 'center' | 'right'
    alignY: 'top'  | 'middle' | 'bottom'
  }) => void
}

const PRESETS: Array<{ label: string; rw: number; rh: number }> = [
  { label: '1:1',  rw: 1,  rh: 1 },
  { label: '4:3',  rw: 4,  rh: 3 },
  { label: '3:4',  rw: 3,  rh: 4 },
  { label: '16:9', rw: 16, rh: 9 },
  { label: '9:16', rw: 9,  rh: 16 },
  { label: '21:9', rw: 21, rh: 9 },
]

type Anchor =
  | 'tl' | 't' | 'tr'
  | 'l'  |       'r'
  | 'bl' | 'b' | 'br'

const HANDLES: Array<{ id: Anchor; cls: string; cursor: string }> = [
  { id: 'tl', cls: '-top-1 -left-1',                              cursor: 'nwse-resize' },
  { id: 't',  cls: '-top-1 left-1/2 -translate-x-1/2',            cursor: 'ns-resize'  },
  { id: 'tr', cls: '-top-1 -right-1',                             cursor: 'nesw-resize' },
  { id: 'l',  cls: 'top-1/2 -translate-y-1/2 -left-1',            cursor: 'ew-resize'  },
  { id: 'r',  cls: 'top-1/2 -translate-y-1/2 -right-1',           cursor: 'ew-resize'  },
  { id: 'bl', cls: '-bottom-1 -left-1',                           cursor: 'nesw-resize' },
  { id: 'b',  cls: '-bottom-1 left-1/2 -translate-x-1/2',         cursor: 'ns-resize'  },
  { id: 'br', cls: '-bottom-1 -right-1',                          cursor: 'nwse-resize' },
]

/**
 * 任意尺寸扩图的画布内 8 手柄交互(替代原 OutpaintDialog Modal)。
 *
 * 视觉(对齐 lintu UI):
 *   - 半透明蒙层覆盖画布,target rect 内"透明"显示原图(其实只显示边框 + handle)
 *   - 选中原图位置保持不动(由 CanvasStage 的 Konva 层正常渲染)
 *   - 这一层只画:target rect 边框 + 8 个 handle + 顶部尺寸文字 + 底部预设/生成按钮
 *
 * 工作原理:
 *   - target rect 初始 = 原图 bounds(没扩);用户拖 handle 把 rect 向外扩
 *   - 原图始终在 (sourceBounds.x, sourceBounds.y, sourceBounds.width, sourceBounds.height)
 *   - target rect 必须包含原图(语义:原图保留在内,target 是包络)
 *   - 提交时计算 alignX/Y:看原图在 target 内的相对位置 →
 *     左缘对齐 = 'left',右缘对齐 = 'right',否则 'center'(中间 ± 30% 都算 center)
 *   - 调 /generate type=outpaint target_w/h + align_x/y
 */
export function OutpaintOverlay({
  sourceBounds, viewport, busy, onCancel, onSubmit,
}: OutpaintOverlayProps) {
  // target 用画布坐标系(逻辑像素);DOM 渲染时再乘 scale
  const [target, setTarget] = useState(() => ({
    x: sourceBounds.x, y: sourceBounds.y,
    w: sourceBounds.width, h: sourceBounds.height,
  }))

  // 拖拽状态
  const dragRef = useRef<{
    anchor: Anchor
    startMouseX: number; startMouseY: number
    startTarget: { x: number; y: number; w: number; h: number }
  } | null>(null)

  // 应用预设比例:让长边 ≥ 原图长边,按比例补另一边;align 居中
  const applyPreset = (rw: number, rh: number) => {
    const baseLong = Math.max(sourceBounds.width, sourceBounds.height, 1024)
    let tw: number, th: number
    if (rw >= rh) {
      tw = baseLong
      th = Math.round(baseLong * rh / rw)
    } else {
      th = baseLong
      tw = Math.round(baseLong * rw / rh)
    }
    tw = Math.max(tw, sourceBounds.width)
    th = Math.max(th, sourceBounds.height)
    // 居中放原图
    setTarget({
      x: sourceBounds.x + (sourceBounds.width  - tw) / 2,
      y: sourceBounds.y + (sourceBounds.height - th) / 2,
      w: tw, h: th,
    })
  }

  // DOM 坐标计算 — target rect → screen
  const dom = useMemo(() => ({
    left:   target.x * viewport.scale + viewport.x,
    top:    target.y * viewport.scale + viewport.y,
    width:  target.w * viewport.scale,
    height: target.h * viewport.scale,
  }), [target.x, target.y, target.w, target.h, viewport.scale, viewport.x, viewport.y])

  // 鼠标拖 handle
  const onHandleDown = (e: React.MouseEvent, anchor: Anchor) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      anchor,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startTarget: { ...target, w: target.w, h: target.h },
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp, { once: true })
  }
  const onMove = (e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    const dxCanvas = (e.clientX - d.startMouseX) / viewport.scale
    const dyCanvas = (e.clientY - d.startMouseY) / viewport.scale
    let { x, y, w, h } = d.startTarget
    const sx = sourceBounds.x
    const sy = sourceBounds.y
    const sx2 = sourceBounds.x + sourceBounds.width
    const sy2 = sourceBounds.y + sourceBounds.height
    // 按 anchor 决定哪条边动
    const ax = d.anchor
    if (ax === 'tl' || ax === 'l' || ax === 'bl') {
      // 左边动:x + (-dx) 增长 → 新 x 减小 = x + dx
      const newX = d.startTarget.x + dxCanvas
      // 不能让 target 右缘进入原图左缘以右(右缘必须 ≥ sx2),不能让 target 左缘进入原图左缘以右
      const maxX = Math.min(sx, d.startTarget.x + d.startTarget.w - 64)
      x = Math.min(maxX, newX)
      w = d.startTarget.x + d.startTarget.w - x
    }
    if (ax === 'tr' || ax === 'r' || ax === 'br') {
      const newW = d.startTarget.w + dxCanvas
      w = Math.max(sx2 - d.startTarget.x, newW)
    }
    if (ax === 'tl' || ax === 't' || ax === 'tr') {
      const newY = d.startTarget.y + dyCanvas
      const maxY = Math.min(sy, d.startTarget.y + d.startTarget.h - 64)
      y = Math.min(maxY, newY)
      h = d.startTarget.y + d.startTarget.h - y
    }
    if (ax === 'bl' || ax === 'b' || ax === 'br') {
      const newH = d.startTarget.h + dyCanvas
      h = Math.max(sy2 - d.startTarget.y, newH)
    }
    // 限制 target 必须包含整个原图
    if (x > sx) x = sx
    if (y > sy) y = sy
    if (x + w < sx2) w = sx2 - x
    if (y + h < sy2) h = sy2 - y
    // 8192 上限
    if (w > 8192) w = 8192
    if (h > 8192) h = 8192
    setTarget({ x, y, w, h })
  }
  const onUp = () => {
    dragRef.current = null
    document.removeEventListener('mousemove', onMove)
  }

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  // 计算 align_x / align_y(原图在 target 内的位置)
  const computeAlign = (): { alignX: 'left'|'center'|'right'; alignY: 'top'|'middle'|'bottom' } => {
    const dxLeft  = sourceBounds.x - target.x
    const dxRight = (target.x + target.w) - (sourceBounds.x + sourceBounds.width)
    const dyTop   = sourceBounds.y - target.y
    const dyBot   = (target.y + target.h) - (sourceBounds.y + sourceBounds.height)
    const alignX = dxLeft  < 8 ? 'left' : (dxRight < 8 ? 'right' : 'center')
    const alignY = dyTop   < 8 ? 'top'  : (dyBot   < 8 ? 'bottom' : 'middle')
    return { alignX, alignY }
  }

  const targetW = Math.round(target.w)
  const targetH = Math.round(target.h)
  const sourceW = Math.round(sourceBounds.width)
  const sourceH = Math.round(sourceBounds.height)
  const isDifferent = targetW !== sourceW || targetH !== sourceH
  const align = computeAlign()

  return (
    <>
      {/* 全屏半透明蒙层 — pointer-events-none 让 handle 之外的点击穿透回画布 */}
      <div className="pointer-events-none absolute inset-0 z-20 bg-black/35" />

      {/* target rect outline + 8 handle */}
      <div
        className="absolute z-30 border-2 border-dashed border-accent rounded-sm pointer-events-none"
        style={{ left: dom.left, top: dom.top, width: dom.width, height: dom.height }}
      >
        {HANDLES.map((h) => (
          <div
            key={h.id}
            onMouseDown={(e) => onHandleDown(e, h.id)}
            style={{ cursor: h.cursor }}
            className={cn(
              'pointer-events-auto absolute h-3 w-3 rounded-sm bg-white border border-accent',
              'shadow-[0_1px_3px_rgba(0,0,0,0.18)]',
              h.cls,
            )}
          />
        ))}
      </div>

      {/* 顶部尺寸文字 */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30
                      rounded-full border border-foreground/8 bg-background/98 backdrop-blur-md
                      px-3 py-1 shadow-[0_4px_16px_rgba(0,0,0,0.06)]
                      text-[12px] text-foreground/80 tabular-nums whitespace-nowrap">
        原图 <strong>{sourceW}×{sourceH}</strong> → 目标 <strong className="text-accent">{targetW}×{targetH}</strong>
        {isDifferent && (
          <span className="text-[11px] text-foreground/45 ml-2">
            · 对齐 {align.alignX}/{align.alignY}
          </span>
        )}
      </div>

      {/* 底部预设 chips + 生成 / 取消 */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30
                      flex items-center gap-2 max-w-[calc(100vw-40px)]
                      rounded-2xl border border-foreground/8 bg-background/98 backdrop-blur-md
                      shadow-[0_8px_24px_rgba(0,0,0,0.08)] px-3 py-2">
        <span className="text-[11px] text-foreground/45 shrink-0">预设比例</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyPreset(p.rw, p.rh)}
            disabled={busy}
            className="h-7 px-2.5 rounded-md text-[11.5px] text-foreground/65 shrink-0
                       border border-foreground/12 hover:bg-foreground/[0.05] hover:text-foreground
                       transition-colors disabled:opacity-40"
          >
            {p.label}
          </button>
        ))}
        <div className="w-px h-5 bg-foreground/10 mx-0.5 shrink-0" />
        <Button variant="outline" size="sm" className="h-7 text-[11.5px] shrink-0"
                onClick={onCancel} disabled={busy}>
          <X size={11} className="mr-1" /> 取消
        </Button>
        <Button size="sm" className="h-7 text-[11.5px] shrink-0"
                disabled={busy || !isDifferent}
                onClick={() => onSubmit({
                  targetW, targetH,
                  alignX: align.alignX, alignY: align.alignY,
                })}>
          {busy
            ? <><Loader2 size={11} className="mr-1.5 animate-spin" /> 生成中</>
            : <><Sparkles size={11} className="mr-1.5" /> 生成 2 张 · {targetW}×{targetH}</>}
        </Button>
      </div>
    </>
  )
}
