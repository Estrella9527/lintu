import { useState } from 'react'
import { Eraser, Loader2, Paintbrush, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface MaskToolbarProps {
  /** 'inpaint' = 需要用户输 prompt;'eraser' = 不需要(自动消除) */
  type: 'inpaint' | 'eraser'
  brushSize: number
  onBrushSize: (n: number) => void
  onUndo: () => void
  onClear: () => void
  canUndo: boolean
  onCancel: () => void
  onSubmit: (prompt: string) => void
  busy: boolean
}

/**
 * 顶部浮动条:画笔粗细 + 撤销/清空 + Prompt(仅 inpaint)+ 生成 / 取消。
 * 出现条件:maskModeAtom 非空时,CanvasStage 渲染。
 *
 * 视觉对齐 ContextBar 的 pill 风格;但水平上更宽,因为含 prompt input。
 */
export function MaskToolbar({
  type, brushSize, onBrushSize, onUndo, onClear, canUndo,
  onCancel, onSubmit, busy,
}: MaskToolbarProps) {
  const [prompt, setPrompt] = useState('')
  const Icon = type === 'inpaint' ? Paintbrush : Eraser
  const title = type === 'inpaint' ? '局部重绘' : '智能消除'

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100vw-40px)]">
      <div className="flex flex-col gap-2 rounded-2xl border border-foreground/8
                      bg-background/98 backdrop-blur-md
                      shadow-[0_8px_24px_rgba(0,0,0,0.08)] p-3 min-w-[480px]">
        <div className="flex items-center gap-2">
          <Icon size={14} strokeWidth={1.6} className="text-accent" />
          <span className="text-[12.5px] font-medium text-foreground/85">{title}</span>
          <span className="text-[11px] text-foreground/45">·  按住鼠标拖动涂抹要修改的区域</span>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="ml-auto h-6 w-6 inline-flex items-center justify-center rounded-md
                       text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground"
            title="退出涂抹"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* 粗细 slider */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10.5px] text-foreground/45 w-8">粗细</span>
            <input
              type="range" min={8} max={120} step={2}
              value={brushSize}
              onChange={(e) => onBrushSize(Number(e.target.value))}
              className="w-24 accent-accent"
              disabled={busy}
            />
            <span className="text-[10.5px] text-foreground/55 tabular-nums w-7">{brushSize}</span>
          </div>

          <button
            type="button"
            onClick={onUndo}
            disabled={busy || !canUndo}
            title="撤销最后一笔"
            className={cn(
              'h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
              canUndo
                ? 'text-foreground/65 hover:bg-foreground/[0.06] hover:text-foreground'
                : 'text-foreground/25 cursor-not-allowed',
            )}
          >
            <RotateCcw size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={busy || !canUndo}
            title="清空所有涂抹"
            className={cn(
              'h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
              canUndo
                ? 'text-foreground/65 hover:bg-destructive/10 hover:text-destructive'
                : 'text-foreground/25 cursor-not-allowed',
            )}
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>

          {type === 'inpaint' && (
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (canUndo && prompt.trim() && !busy) onSubmit(prompt.trim())
                }
              }}
              placeholder='描述涂抹区要变成什么(Cmd+Enter 提交)'
              className="flex-1 min-h-[32px] max-h-[80px] text-[12px] resize-none py-1.5"
              disabled={busy}
            />
          )}
          {type === 'eraser' && (
            <span className="flex-1 text-[11.5px] text-foreground/45">智能消除涂抹区,自然补背景 — 不需要输描述</span>
          )}

          <Button
            size="sm"
            className="h-8 text-[12px] shrink-0"
            disabled={busy || !canUndo || (type === 'inpaint' && !prompt.trim())}
            onClick={() => onSubmit(type === 'eraser' ? '' : prompt.trim())}
          >
            {busy
              ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> 生成中</>
              : <><Sparkles size={12} className="mr-1.5" /> 生成 2 张</>}
          </Button>
        </div>
      </div>
    </div>
  )
}
