import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface AskAIPopoverProps {
  open: boolean
  onClose: () => void
  onSubmit: (instruction: string) => void
  busy?: boolean
  /** 锚定 DOM 位置 {x, y} — popover 出现在该点下方 */
  anchor: { x: number; y: number }
}

/**
 * Ask AI 浮层输入框 — 用户用自然语言描述想要的修改(如"把天空换成晚霞")。
 *
 * 行为:
 *   - Esc / 点空白 关闭
 *   - Enter 提交,Shift+Enter 换行
 *   - 自动 focus
 *   - busy=true 时禁用按钮 + 显示 loader
 */
export function AskAIPopover({ open, onClose, onSubmit, busy, anchor }: AskAIPopoverProps) {
  const [text, setText] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (open) {
      setText('')
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={wrapRef}
      className="absolute z-30 w-[340px] rounded-xl border border-foreground/8
                 bg-background/98 backdrop-blur-sm
                 shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-3"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] text-foreground/55 mb-2">
        <Sparkles size={11} className="text-accent" />
        <span>用一句话告诉 AI 你想怎么改这张图</span>
      </div>
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (text.trim() && !busy) onSubmit(text.trim())
          }
        }}
        placeholder='例如:"把天空换成晚霞" / "去掉左边的游客" / "整体偏日系清新"'
        className="min-h-[72px] text-[12.5px] resize-none"
        disabled={busy}
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-[10.5px] text-foreground/40">Enter 发送 · Shift+Enter 换行 · Esc 关闭</span>
        <Button
          size="sm"
          className="h-7 text-[12px]"
          disabled={!text.trim() || busy}
          onClick={() => onSubmit(text.trim())}
        >
          {busy
            ? <><Loader2 size={11} className="mr-1.5 animate-spin" /> 生成中</>
            : <>生成</>}
        </Button>
      </div>
    </div>
  )
}
