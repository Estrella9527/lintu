import { useEffect, useRef } from 'react'

interface Props {
  length?: number
  value: string
  onChange: (v: string) => void
  onComplete?: (v: string) => void
  disabled?: boolean
  autoFocus?: boolean
}

/**
 * 6 格分离式验证码输入框。
 *
 * 行为：
 *   - 输入数字自动跳到下一格；最后一格触发 onComplete
 *   - Backspace 在空格里跳回上一格
 *   - 粘贴 6 位数字（用户从短信 / 微信复制）一次填满
 *   - 左右方向键移动焦点
 */
export function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
}: Props) {
  const refs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  // value 比 length 短的情况补空字符
  const chars = value.padEnd(length, ' ').split('').slice(0, length)

  const setAt = (i: number, ch: string) => {
    const next = chars.slice()
    next[i] = ch
    const merged = next.join('').replace(/\s/g, '')
    onChange(merged)
    if (merged.length === length) onComplete?.(merged)
  }

  const focusAt = (i: number) => {
    const idx = Math.max(0, Math.min(length - 1, i))
    refs.current[idx]?.focus()
    refs.current[idx]?.select()
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (chars[i] && chars[i] !== ' ') {
        setAt(i, ' ')
      } else {
        setAt(Math.max(0, i - 1), ' ')
        focusAt(i - 1)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusAt(i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusAt(i + 1)
    }
  }

  const handleChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, '').slice(-1)
    if (!digit) return
    setAt(i, digit)
    focusAt(i + 1)
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)
    if (!digits) return
    onChange(digits)
    if (digits.length === length) {
      onComplete?.(digits)
      refs.current[length - 1]?.focus()
    } else {
      focusAt(digits.length)
    }
  }

  return (
    <div className="flex justify-between gap-2" onPaste={handlePaste}>
      {chars.map((ch, i) => {
        const display = ch === ' ' ? '' : ch
        const filled = display !== ''
        return (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el }}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={1}
            value={display}
            disabled={disabled}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onFocus={(e) => e.currentTarget.select()}
            className={[
              'h-12 w-10 rounded-lg border text-center text-[18px] font-medium tabular-nums',
              'transition-all outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/60',
              filled
                ? 'border-foreground/25 bg-background text-foreground'
                : 'border-foreground/12 bg-foreground/[0.02] text-foreground/30',
              disabled ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
          />
        )
      })}
    </div>
  )
}
