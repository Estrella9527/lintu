import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface MultiSelectOption {
  value: string
  label: string
  /** 可选的次级文本（如分类、调用次数） */
  description?: string
}

interface MultiSelectPopoverProps {
  /** 触发按钮上展示的字段名（"Prompt" / "场景" 等） */
  label: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  /** 触发器右侧的覆盖文本（默认显示 "已选 N / 共 M"） */
  triggerSuffix?: ReactNode
  searchable?: boolean
  /** 弹层最大高度，超出滚动 */
  maxHeight?: number
  /** 弹层宽度（默认 280） */
  width?: number
  /** 触发器禁用状态 + tooltip */
  disabled?: boolean
  disabledHint?: string
  /** 单选模式（保持组件复用） */
  single?: boolean
  className?: string
  /** 当 selected 不为空时，触发器旁是否显示「清空」按钮 */
  clearable?: boolean
}

/**
 * 紧凑型多选下拉 — 替代铺开的 chip 列表，节省垂直空间。
 *
 * 设计原则：
 *   - 触发器永远是一行高（h-7），不会撑高表单
 *   - "已选 N / 共 M" 直接写在触发器上，不需要展开就知道选了多少
 *   - 弹层支持搜索 + 全部勾选/反选
 *   - 选中项以 chip 形式渲染在触发器下方（≤6 行高，超出滚动）
 *
 * 用法：
 *   <MultiSelectPopover
 *     label="Prompt"
 *     options={[{ value: 'p1', label: '春日樱花' }, ...]}
 *     selected={ids}
 *     onChange={setIds}
 *     searchable
 *   />
 */
export function MultiSelectPopover({
  label,
  options,
  selected,
  onChange,
  triggerSuffix,
  searchable = false,
  maxHeight = 280,
  width = 320,
  disabled = false,
  disabledHint,
  single = false,
  className,
  clearable = true,
}: MultiSelectPopoverProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const filteredOptions = useMemo(() => {
    if (!query.trim()) return options
    const q = query.trim().toLowerCase()
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.description || '').toLowerCase().includes(q),
    )
  }, [options, query])

  const toggle = (v: string) => {
    if (single) {
      onChange(selectedSet.has(v) ? [] : [v])
      setOpen(false)
      return
    }
    const next = new Set(selectedSet)
    next.has(v) ? next.delete(v) : next.add(v)
    onChange(Array.from(next))
  }

  const allFilteredSelected =
    filteredOptions.length > 0 && filteredOptions.every((o) => selectedSet.has(o.value))
  const toggleAllFiltered = () => {
    const next = new Set(selectedSet)
    if (allFilteredSelected) {
      filteredOptions.forEach((o) => next.delete(o.value))
    } else {
      filteredOptions.forEach((o) => next.add(o.value))
    }
    onChange(Array.from(next))
  }

  const triggerLabel =
    selected.length === 0
      ? '未选'
      : single
        ? options.find((o) => o.value === selected[0])?.label || selected[0]
        : `已选 ${selected.length} / 共 ${options.length}`

  return (
    <div className={cn('space-y-1', className)}>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
        <div className="flex items-center gap-2">
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              title={disabled ? disabledHint : undefined}
              className={cn(
                'flex-1 inline-flex items-center justify-between gap-2 h-7 px-2.5 rounded-md border text-[11.5px] transition-colors',
                disabled
                  ? 'border-foreground/5 bg-foreground/[0.02] text-foreground/30 cursor-not-allowed'
                  : selected.length > 0
                    ? 'border-accent/30 bg-accent/[0.04] text-foreground/85 hover:border-accent/50'
                    : 'border-foreground/10 text-foreground/55 hover:border-foreground/25 hover:bg-foreground/[0.02]',
              )}
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium text-foreground/70">{label}</span>
                <span className={cn('truncate', selected.length === 0 && 'text-foreground/35')}>
                  {triggerLabel}
                </span>
              </span>
              <ChevronDown size={11} className="shrink-0 opacity-60" />
            </button>
          </PopoverTrigger>
          {triggerSuffix}
          {clearable && selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10.5px] text-foreground/40 hover:text-destructive shrink-0"
              title="清空选择"
            >
              清空
            </button>
          )}
        </div>

        <PopoverContent
          align="start"
          sideOffset={4}
          className="p-0"
          style={{ width }}
        >
          {searchable && (
            <div className="p-2 border-b border-foreground/5">
              <div className="relative">
                <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-foreground/35" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`搜索 ${label}…`}
                  className="h-7 text-[11.5px] pl-6"
                  autoFocus
                />
              </div>
            </div>
          )}

          {!single && filteredOptions.length > 1 && (
            <div className="px-2 py-1 border-b border-foreground/5 flex items-center justify-between text-[10.5px] text-foreground/55">
              <button
                type="button"
                onClick={toggleAllFiltered}
                className="hover:text-foreground/85 transition-colors"
              >
                {allFilteredSelected ? '取消当前显示' : '全选当前显示'}
              </button>
              <span className="text-foreground/40">
                {filteredOptions.length} 项
              </span>
            </div>
          )}

          <div className="overflow-y-auto py-1" style={{ maxHeight }}>
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-foreground/35 text-center">
                {query ? '没有匹配项' : '暂无可选项'}
              </div>
            ) : (
              filteredOptions.map((opt) => {
                const active = selectedSet.has(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 text-[11.5px] flex items-center gap-2 transition-colors',
                      active ? 'bg-accent/[0.06] text-foreground/85' : 'text-foreground/65 hover:bg-foreground/[0.03]',
                    )}
                  >
                    <span
                      className={cn(
                        'h-3 w-3 rounded-sm border flex items-center justify-center shrink-0',
                        active ? 'border-accent bg-accent text-accent-foreground' : 'border-foreground/25',
                      )}
                    >
                      {active && <Check size={9} strokeWidth={3} />}
                    </span>
                    <span className="flex-1 min-w-0 truncate">{opt.label}</span>
                    {opt.description && (
                      <span className="text-[10px] text-foreground/40 shrink-0">{opt.description}</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {!single && selected.length > 0 && selected.length <= 12 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((v) => {
            const meta = options.find((o) => o.value === v)
            return (
              <span
                key={v}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-accent/10 text-accent text-[10.5px] border border-accent/20"
              >
                {meta?.label || v}
                <button
                  type="button"
                  onClick={() => toggle(v)}
                  className="opacity-70 hover:opacity-100"
                >
                  <X size={9} />
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
