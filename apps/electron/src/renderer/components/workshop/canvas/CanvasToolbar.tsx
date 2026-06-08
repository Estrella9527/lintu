import { useEffect, useState } from 'react'
import { Cloud, FilePlus, Maximize2, Redo2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CanvasToolbarProps {
  scalePercent: number              // 0~∞,显示如 "100%"
  onResetView: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** v0.3 PR-16:最近一次自动保存时间;null = 尚未保存过 */
  lastSavedAt?: Date | null
  /** 新建画布 / 清空当前画布 */
  onClearCanvas?: () => void
}

/**
 * 画布顶部小工具条 — 缩放百分比 + 居中复位 + Undo/Redo + 自动保存指示 + 新建画布。
 * 视觉风格对齐 lintu 主导航 / Stat 卡片(浅灰底 + ghost 按钮)。
 */
export function CanvasToolbar({
  scalePercent, onResetView, onUndo, onRedo, canUndo, canRedo,
  lastSavedAt, onClearCanvas,
}: CanvasToolbarProps) {
  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10
                    flex items-center gap-1 rounded-lg border border-foreground/8
                    bg-background/95 backdrop-blur-sm px-2 py-1
                    shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <ToolbarButton title="撤销 (⌘Z)" disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={13} strokeWidth={1.6} />
      </ToolbarButton>
      <ToolbarButton title="重做 (⌘⇧Z)" disabled={!canRedo} onClick={onRedo}>
        <Redo2 size={13} strokeWidth={1.6} />
      </ToolbarButton>
      <div className="w-px h-4 bg-foreground/10 mx-0.5" />
      <button
        onClick={onResetView}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]
                   text-foreground/70 hover:bg-foreground/[0.06] transition-colors
                   tabular-nums"
        title="复位视图 (按 0 复位)"
      >
        <Maximize2 size={11} strokeWidth={1.5} />
        {Math.round(scalePercent)}%
      </button>

      {/* PR-16:自动保存指示 + 新建画布按钮 */}
      <div className="w-px h-4 bg-foreground/10 mx-0.5" />
      <SavedIndicator at={lastSavedAt} />
      {onClearCanvas && (
        <ToolbarButton
          title="新建画布(清空当前 + 重置 Prompt 草稿)"
          onClick={onClearCanvas}
        >
          <FilePlus size={13} strokeWidth={1.6} />
        </ToolbarButton>
      )}
    </div>
  )
}

function ToolbarButton({
  children, title, disabled, onClick,
}: {
  children: React.ReactNode
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'h-6 w-6 inline-flex items-center justify-center rounded-md transition-colors',
        disabled
          ? 'text-foreground/25 cursor-not-allowed'
          : 'text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** 「已保存 N 秒前」状态 — 每 15s 重算一次 */
function SavedIndicator({ at }: { at: Date | null | undefined }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  if (!at) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 text-[10.5px] text-foreground/35" title="尚未保存">
        <Cloud size={10} strokeWidth={1.5} />
        未保存
      </span>
    )
  }
  const delta = Date.now() - at.getTime()
  const label =
    delta < 5_000  ? '刚刚已保存' :
    delta < 60_000 ? `${Math.round(delta / 1000)} 秒前已保存` :
    delta < 3_600_000 ? `${Math.round(delta / 60_000)} 分钟前已保存` :
                        `${Math.round(delta / 3_600_000)} 小时前已保存`
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 text-[10.5px] text-foreground/55"
      title={`画布按项目自动保存到本机 · ${at.toLocaleString()}`}
    >
      <Cloud size={10} strokeWidth={1.5} className="text-success" />
      {label}
    </span>
  )
}
