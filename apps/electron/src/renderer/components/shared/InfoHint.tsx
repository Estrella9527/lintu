import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  /** 鼠标悬停时显示的解释。简短一句话；多句用 \n 分隔，组件会自动换行渲染。 */
  text: string
  /** icon 大小，默认 12 */
  size?: number
  /** 额外 className（如调位置 / 颜色） */
  className?: string
  /** 浮窗放在 icon 的哪一侧。默认 top；空间不足时自动翻转到对侧。 */
  side?: 'top' | 'bottom' | 'left' | 'right'
}

const TOOLTIP_GAP = 6      // tooltip 与 trigger 的间距
const VIEWPORT_PAD = 8     // 距离视口边缘的最小留白
const ESTIMATED_W = 320    // 用于初次定位的估算宽度（max-w-[320px]）
const ESTIMATED_H = 80     // 同上估算高度

/**
 * 一个 Info icon + hover 浮窗 — 替代冗长的副标题段落。
 *
 * 关键实现细节：
 *   - **Portal 到 document.body**：避开 Radix Dialog / Popover 的 transform
 *     父级（transform 会让 position:fixed 子元素相对于父级而非 viewport，
 *     导致 tooltip 出现在错误位置）。
 *   - **视口边界 clamp**：tooltip 如果超出屏幕，会被夹回 viewport 内；
 *     side 上下空间不足会自动翻转到对侧。
 *   - **hover 关闭加 100ms 延迟**：避免 trigger → tooltip 移动时的空隙抖动。
 *   - **支持键盘**：focus 时显示，ESC 关闭，role=note + aria。
 */
export function InfoHint({ text, size = 12, className, side = 'top' }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [actualSide, setActualSide] = useState(side)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const scheduleClose = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 100)
  }
  const cancelClose = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  // 用 useLayoutEffect 在 paint 前算位置，避免 flash
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return

    const r = triggerRef.current.getBoundingClientRect()
    const ttW = tooltipRef.current?.offsetWidth ?? ESTIMATED_W
    const ttH = tooltipRef.current?.offsetHeight ?? ESTIMATED_H
    const vw = window.innerWidth
    const vh = window.innerHeight

    // 决定最终 side：top/bottom 检查上下空间，left/right 检查左右空间
    let chosen = side
    if (side === 'top' && r.top - ttH - TOOLTIP_GAP < VIEWPORT_PAD) chosen = 'bottom'
    else if (side === 'bottom' && r.bottom + ttH + TOOLTIP_GAP > vh - VIEWPORT_PAD) chosen = 'top'
    else if (side === 'left' && r.left - ttW - TOOLTIP_GAP < VIEWPORT_PAD) chosen = 'right'
    else if (side === 'right' && r.right + ttW + TOOLTIP_GAP > vw - VIEWPORT_PAD) chosen = 'left'

    let top: number, left: number
    if (chosen === 'top') {
      top = r.top - TOOLTIP_GAP - ttH
      left = r.left + r.width / 2 - ttW / 2
    } else if (chosen === 'bottom') {
      top = r.bottom + TOOLTIP_GAP
      left = r.left + r.width / 2 - ttW / 2
    } else if (chosen === 'left') {
      top = r.top + r.height / 2 - ttH / 2
      left = r.left - TOOLTIP_GAP - ttW
    } else {
      top = r.top + r.height / 2 - ttH / 2
      left = r.right + TOOLTIP_GAP
    }

    // clamp 到 viewport 内
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - ttW - VIEWPORT_PAD))
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - ttH - VIEWPORT_PAD))

    setActualSide(chosen)
    setPos({ top, left })
  }, [open, side, text])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 滚动时关闭（避免 tooltip 浮在错位置）
  useEffect(() => {
    if (!open) return
    const onScroll = () => setOpen(false)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [open])

  return (
    <>
      <span
        ref={triggerRef}
        role="note"
        tabIndex={0}
        onMouseEnter={() => { cancelClose(); setOpen(true) }}
        onMouseLeave={scheduleClose}
        onFocus={() => { cancelClose(); setOpen(true) }}
        onBlur={() => setOpen(false)}
        className={cn(
          'inline-flex items-center justify-center text-foreground/35 hover:text-foreground/65 transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-full',
          className,
        )}
      >
        <Info size={size} />
      </span>

      {open && createPortal(
        <div
          ref={tooltipRef}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
            zIndex: 9999,
            pointerEvents: 'auto',
            maxWidth: '320px',
          }}
          data-side={actualSide}
          className="whitespace-pre-line rounded-md bg-foreground/95 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-background shadow-lg backdrop-blur-sm dark:bg-foreground/85"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}
