import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'

import { activeProjectIdAtom } from '@/atoms/project'

import { Filter, Search, Tags, Wand2, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'passed', label: '已通过' },
  { value: 'rejected', label: '已淘汰' },
  { value: 'pending', label: '待处理' },
]

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'original', label: '原图' },
  { value: 'generated', label: '全部生成图' },
  { value: 'crop', label: '裁剪' },
  { value: 'upscale', label: '超分' },
  { value: 'outpaint', label: '画布扩展' },
  { value: 'seasonal', label: '季节变换' },
  { value: 'style', label: '风格变换' },
  { value: 'inpaint', label: '局部编辑' },
  { value: 'marketing', label: '营销素材' },
]

// Tag dimensions exposed in the popover. Order matters — user scans top→bottom
// looking for the dimension they want. We put "soft tags" (visual style /
// mood / theme) near the top because that's the new high-value path users
// most want to filter by.
const TAG_DIMENSIONS: { key: keyof TagFilterMap; label: string }[] = [
  { key: 'style',       label: '视觉风格' },
  { key: 'mood',        label: '情绪氛围' },
  { key: 'theme',       label: '适用主题' },
  { key: 'palette',     label: '色彩调性' },
  { key: 'composition', label: '构图技法' },
  { key: 'scene',       label: '场景类型' },
  { key: 'facility',    label: '项目设施' },
  { key: 'season',      label: '季节' },
  { key: 'weather',     label: '天气光线' },
  { key: 'angle',       label: '视角' },
  { key: 'people',      label: '人物' },
  { key: 'usage',       label: '画面用途' },
]

export interface TagFilterMap {
  scene: string[]
  facility: string[]
  season: string[]
  weather: string[]
  angle: string[]
  people: string[]
  usage: string[]
  style: string[]
  mood: string[]
  palette: string[]
  theme: string[]
  composition: string[]
}

export interface FilterState {
  search: string
  status: string
  source: string
  tags: TagFilterMap
  prompt_id: string         // empty = no prompt filter
  prompt_label: string      // human-readable label for display
  parent_id: string         // empty = no derivative-of filter
  parent_label: string      // human-readable label for display
}

export const EMPTY_TAG_FILTERS: TagFilterMap = {
  scene: [], facility: [], season: [], weather: [], angle: [], people: [], usage: [],
  style: [], mood: [], palette: [], theme: [], composition: [],
}

export const EMPTY_FILTER: FilterState = {
  search: '', status: 'all', source: 'all',
  tags: EMPTY_TAG_FILTERS,
  prompt_id: '', prompt_label: '',
  parent_id: '', parent_label: '',
}

interface FilterBarProps {
  filter: FilterState
  onChange: (filter: FilterState) => void
}

export function FilterBar({ filter, onChange }: FilterBarProps) {
  const totalTagCount = Object.values(filter.tags).reduce((s, vs) => s + vs.length, 0)
  const hasFilters =
    filter.search || filter.status !== 'all' || filter.source !== 'all'
    || totalTagCount > 0 || !!filter.prompt_id || !!filter.parent_id

  return (
    <div className="space-y-2 mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/35" />
          <Input
            placeholder="搜索文件名..."
            value={filter.search}
            onChange={(e) => onChange({ ...filter, search: e.target.value })}
            className="w-44 h-8 pl-7 text-[13px]"
          />
        </div>

        <Select value={filter.status} onValueChange={(v) => onChange({ ...filter, status: v })}>
          <SelectTrigger className="w-28 h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filter.source} onValueChange={(v) => onChange({ ...filter, source: v })}>
          <SelectTrigger className="w-32 h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <TagFilterPopover
          tags={filter.tags}
          onChange={(tags) => onChange({ ...filter, tags })}
          activeCount={totalTagCount}
        />

        <PromptFilterPopover
          value={filter.prompt_id}
          label={filter.prompt_label}
          onChange={(id, label) => onChange({ ...filter, prompt_id: id, prompt_label: label })}
        />

        {hasFilters && (
          <Button
            variant="ghost" size="sm"
            className="h-8 px-2 text-[12px] text-foreground/50"
            onClick={() => onChange({ ...EMPTY_FILTER })}
          >
            <X size={12} className="mr-1" /> 清除全部
          </Button>
        )}
      </div>

      {/* Active filter chips — one row, click × to remove individually */}
      {(totalTagCount > 0 || !!filter.prompt_id || !!filter.parent_id) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-foreground/40">筛选条件：</span>
          {TAG_DIMENSIONS.map(({ key, label }) =>
            filter.tags[key].map((value) => (
              <Chip
                key={`${key}-${value}`}
                onRemove={() => {
                  const next = { ...filter.tags, [key]: filter.tags[key].filter((v) => v !== value) }
                  onChange({ ...filter, tags: next })
                }}
              >
                <span className="text-foreground/45">{label}:</span>
                <span className="text-foreground/85 ml-0.5">{value}</span>
              </Chip>
            ))
          )}
          {filter.prompt_id && (
            <Chip
              onRemove={() => onChange({ ...filter, prompt_id: '', prompt_label: '' })}
              tone="accent"
            >
              <Wand2 size={10} className="mr-0.5" />
              <span>{filter.prompt_label || filter.prompt_id.slice(0, 8)}</span>
            </Chip>
          )}
          {filter.parent_id && (
            <Chip
              onRemove={() => onChange({ ...filter, parent_id: '', parent_label: '' })}
              tone="accent"
            >
              <span className="text-foreground/45">衍生自:</span>
              <span className="ml-0.5">{filter.parent_label || filter.parent_id.slice(0, 8)}</span>
            </Chip>
          )}
        </div>
      )}
    </div>
  )
}


// ── TagFilterPopover ────────────────────────────────────────────────────────


function TagFilterPopover({
  tags, onChange, activeCount,
}: {
  tags: TagFilterMap
  onChange: (next: TagFilterMap) => void
  activeCount: number
}) {
  const { data: schema } = useQuery<Record<string, { values: string[] }>>({
    queryKey: ['tag-schema'],
    queryFn: () => fetch('http://localhost:7879/api/tag-schema').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })

  const toggle = (dim: keyof TagFilterMap, value: string) => {
    const cur = tags[dim] || []
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    onChange({ ...tags, [dim]: next })
  }

  const clearDim = (dim: keyof TagFilterMap) => onChange({ ...tags, [dim]: [] })
  const clearAll = () => onChange({ ...EMPTY_TAG_FILTERS })

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline" size="sm"
          className={cn('h-8 text-[13px] gap-1.5', activeCount > 0 && 'border-accent/40 text-accent')}
        >
          <Tags size={13} /> 标签
          {activeCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px] tabular-nums bg-accent/15 text-accent">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[440px] max-h-[520px] p-0 overflow-hidden flex flex-col"
        align="start"
      >
        <div className="px-3 py-2 border-b border-foreground/8 flex items-center justify-between">
          <span className="text-[12px] font-medium text-foreground/75">按标签筛选</span>
          <span className="text-[10.5px] text-foreground/40">
            维度内 OR · 跨维度 AND
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {TAG_DIMENSIONS.map(({ key, label }) => {
            const values = schema?.[key]?.values ?? []
            const selected = tags[key] || []
            return (
              <div key={key}>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[11.5px] font-medium text-foreground/65">{label}</span>
                  <span className="text-[10px] text-foreground/35">{values.length}</span>
                  {selected.length > 0 && (
                    <button
                      onClick={() => clearDim(key)}
                      className="ml-auto text-[10px] text-foreground/35 hover:text-destructive"
                    >
                      清除 ({selected.length})
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {values.length === 0 && (
                    <span className="text-[10.5px] text-foreground/30">该维度暂无值</span>
                  )}
                  {values.map((v) => {
                    const active = selected.includes(v)
                    return (
                      <button
                        key={v}
                        onClick={() => toggle(key, v)}
                        className={cn(
                          'px-2 h-6 rounded text-[11px] border transition-colors',
                          active
                            ? 'border-accent bg-accent/10 text-accent'
                            : 'border-foreground/10 text-foreground/60 hover:bg-foreground/[0.04]',
                        )}
                      >
                        {v}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
        {activeCount > 0 && (
          <div className="px-3 py-2 border-t border-foreground/8 flex items-center justify-between">
            <span className="text-[10.5px] text-foreground/45">已选 {activeCount} 项</span>
            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={clearAll}>
              全部清除
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}


// ── PromptFilterPopover ────────────────────────────────────────────────────


interface PromptWithCount {
  id: string
  name: string
  category: string
  task_type: string | null
  is_active: boolean
  output_count: number
}

function PromptFilterPopover({
  value, label, onChange,
}: {
  value: string
  label: string
  onChange: (id: string, label: string) => void
}) {
  const [search, setSearch] = useState('')
  const [showZero, setShowZero] = useState(false)
  const projectId = useAtomValue(activeProjectIdAtom)

  // Project-scoped so the counts match the grid the user is looking at —
  // without this, totals were the cross-project sum and 对不上号.
  // refetchOnMount: 'always' refreshes every time the popover opens (Radix
  // unmounts content on close), so a batch run that finished while the
  // popover was closed will be reflected the next time it's opened.
  const { data: prompts } = useQuery<PromptWithCount[]>({
    queryKey: ['prompts', 'with-output-counts', projectId],
    queryFn: () => {
      const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''
      return fetch(`http://localhost:7879/api/prompts/with-output-counts${qs}`).then((r) => r.json())
    },
    enabled: !!projectId,
    refetchOnMount: 'always',
    staleTime: 5 * 1000,
  })

  const all = prompts ?? []
  const totalUsed = all.filter((p) => p.output_count > 0).length
  const totalGenerated = all.reduce((s, p) => s + p.output_count, 0)
  const filtered = all
    .filter((p) => showZero || p.output_count > 0)
    .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline" size="sm"
          className={cn('h-8 text-[13px] gap-1.5', value && 'border-accent/40 text-accent')}
          title="按 AI Prompt 筛选生成图"
        >
          <Wand2 size={13} /> Prompt
          {value && (
            <span className="text-[11px] truncate max-w-[80px]">{label || '已选'}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] max-h-[480px] p-0 overflow-hidden flex flex-col" align="start">
        <div className="px-3 py-2 border-b border-foreground/8 space-y-2">
          <div className="flex items-center justify-between text-[10.5px] text-foreground/45">
            <span>{totalUsed} 个 prompt 有生成图 · 共 {totalGenerated.toLocaleString()} 张</span>
            <button
              onClick={() => setShowZero(!showZero)}
              className="hover:text-foreground/75"
              title="包含未使用过的 prompt"
            >
              {showZero ? '✓ 含未使用' : '只看有产出'}
            </button>
          </div>
          <Input
            placeholder="搜索 prompt 名称..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-[12px]"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => onChange('', '')}
            className={cn(
              'w-full text-left px-3 py-1.5 text-[12px] hover:bg-foreground/[0.04]',
              !value && 'bg-accent/[0.06] text-accent',
            )}
          >
            ✕ 不筛选 prompt
          </button>
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-foreground/40 text-center">
              {search ? '没有匹配的 prompt' : '尚无生成图（去 AI 工坊跑一次批次）'}
            </div>
          )}
          {filtered.map((p) => {
            const active = value === p.id
            const isZero = p.output_count === 0
            return (
              <button
                key={p.id}
                onClick={() => onChange(p.id, p.name)}
                className={cn(
                  'w-full text-left px-3 py-1.5 text-[12px] hover:bg-foreground/[0.04] flex items-center gap-2',
                  active && 'bg-accent/[0.06] text-accent',
                  isZero && 'opacity-55',
                )}
              >
                <span className="flex-1 truncate">{p.name}</span>
                {p.task_type && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                    {p.task_type}
                  </Badge>
                )}
                <span
                  className={cn(
                    'tabular-nums text-[10.5px] shrink-0 min-w-[36px] text-right',
                    isZero ? 'text-foreground/30'
                    : p.output_count >= 50 ? 'text-success font-medium'
                    : p.output_count >= 10 ? 'text-foreground/75'
                    : 'text-foreground/45',
                  )}
                  title={`已生成 ${p.output_count} 张`}
                >
                  {p.output_count}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}


// ── Chip ────────────────────────────────────────────────────────────────────


function Chip({
  children, onRemove, tone = 'default',
}: {
  children: React.ReactNode
  onRemove: () => void
  tone?: 'default' | 'accent'
}) {
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[11px]',
      tone === 'accent'
        ? 'border-accent/30 bg-accent/[0.06] text-accent'
        : 'border-foreground/10 bg-foreground/[0.03]',
    )}>
      {children}
      <button
        onClick={onRemove}
        className="ml-0.5 text-foreground/40 hover:text-destructive"
        aria-label="移除"
      >
        <X size={10} />
      </button>
    </span>
  )
}


// Re-export silenced-by-default unused-import friendly
export { Filter }
