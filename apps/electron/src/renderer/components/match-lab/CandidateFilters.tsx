import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { apiFetchRaw } from '@/lib/api'
import { InfoHint } from '@/components/shared/InfoHint'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MultiSelectPopover, type MultiSelectOption } from '@/components/shared/MultiSelectPopover'
import { cn } from '@/lib/utils'

interface PromptWithCount {
  id: string
  name: string
  category: string
  task_type: string | null
  is_active: boolean
  output_count: number
}

/**
 * 「候选源」筛选 — 把候选池约束到资产库的子集。改造后的紧凑版（2026-05-07）：
 *   - 全部用下拉多选，不再铺开 chip 列表
 *   - 单行触发器，"已选 N / 共 M" 直观可见
 *   - 跨筛选维度仍然是 AND；维度内是 OR
 */

export interface CandidateFilters {
  source_type: 'all' | 'original' | 'generated'
  prompt_ids: string[]
  folder_prefix: string | null
  tags: Partial<Record<'scene' | 'season' | 'weather' | 'facility' | 'people', string[]>>
  image_ids: string[]
}

export const EMPTY_FILTERS: CandidateFilters = {
  source_type: 'all',
  prompt_ids: [],
  folder_prefix: null,
  tags: {},
  image_ids: [],
}

interface Props {
  value: CandidateFilters
  onChange: (next: CandidateFilters) => void
  projectId: string | null
  /** 紧凑模式：只显示触发器行，把 image_id 白名单收成最后一行（默认开） */
  compact?: boolean
  /** 顶部说明 */
  description?: string
}

const SOURCE_TYPE_LABEL: Record<CandidateFilters['source_type'], string> = {
  all:       '全部',
  original:  '仅原图',
  generated: '仅 AI 生成',
}

const TAG_DIM_LABELS: Record<keyof CandidateFilters['tags'], string> = {
  scene:    '场景',
  season:   '季节',
  weather:  '天气光线',
  facility: '设施',
  people:   '人物',
}

export function CandidateFiltersPanel({ value, onChange, projectId, description }: Props) {
  const activeCount = useMemo(() => countActive(value), [value])

  // ── data sources ─────────────────────────────────────────────────────
  const promptsEnabled = value.source_type === 'generated' || value.source_type === 'all'
  // 用 with-output-counts 端点：除了基本信息还带每个 prompt 已生成的图片张数。
  // 后端按 output_count 倒序返回（高使用量在前），这里在 UI 里再加上"未生成"
  // 的标记，让运营一眼分清哪些 prompt 已经投产、哪些是新建未跑过的。
  const { data: prompts } = useQuery<PromptWithCount[]>({
    queryKey: ['prompts', 'with-output-counts', projectId],
    queryFn: () => apiFetchRaw(
      `/prompts/with-output-counts${projectId ? `?project_id=${projectId}` : ''}`,
    ).then((r) => r.json()),
    staleTime: 60_000,
  })
  const promptOptions: MultiSelectOption[] = useMemo(() => {
    if (!Array.isArray(prompts)) return []
    return prompts
      .filter((p) => p.is_active)
      .map((p) => ({
        value: p.id,
        label: p.name,
        // 显示在右侧灰字的 description：直接用图片数量。0 张时显示"未生成"
        // 而不是 "0"，避免运营误以为是 bug。
        description: p.output_count > 0 ? `${p.output_count} 张` : '未生成',
      }))
  }, [prompts])

  const { data: folders } = useQuery<{ folder: string; count: number }[]>({
    queryKey: ['folders', projectId],
    queryFn: () => apiFetchRaw(`/images/folders?project_id=${projectId}`).then((r) => r.json()),
    enabled: !!projectId,
    staleTime: 60_000,
  })
  const folderOptions: MultiSelectOption[] = useMemo(() => {
    if (!Array.isArray(folders)) return []
    return folders.map((f) => ({
      value: f.folder,
      label: f.folder || '(根目录)',
      description: String(f.count),
    }))
  }, [folders])

  const { data: schema } = useQuery<Record<string, { label: string; values: string[] }>>({
    queryKey: ['tag-schema'],
    queryFn: () => apiFetchRaw(`/tag-schema`).then((r) => r.json()),
    staleTime: 60_000,
  })

  // ── handlers ─────────────────────────────────────────────────────────
  const setSourceType = (st: CandidateFilters['source_type']) =>
    onChange({ ...value, source_type: st })
  const setPromptIds = (ids: string[]) => onChange({ ...value, prompt_ids: ids })
  const setFolderPrefix = (vals: string[]) =>
    onChange({ ...value, folder_prefix: vals.length > 0 ? vals[0] : null })
  const setTagDim = (dim: keyof CandidateFilters['tags'], vals: string[]) =>
    onChange({
      ...value,
      tags: { ...value.tags, [dim]: vals.length > 0 ? vals : undefined },
    })

  return (
    <div className="space-y-3">
      {(description || activeCount > 0) && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-foreground/55">
            {description || '把候选池约束到资产库的子集；空 = 全库召回'}
          </span>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTERS)}
              className="text-foreground/45 hover:text-destructive"
            >
              清空全部 ({activeCount})
            </button>
          )}
        </div>
      )}

      {/* Row 1: source_type (segmented) + prompt 多选 */}
      <div className="grid grid-cols-2 gap-2">
        <SegmentedSourceType value={value.source_type} onChange={setSourceType} />
        <MultiSelectPopover
          label="Prompt"
          options={promptOptions}
          selected={value.prompt_ids}
          onChange={setPromptIds}
          searchable
          width={340}
          disabled={!promptsEnabled}
          disabledHint="先把「来源类型」设为「全部」或「仅 AI 生成」"
        />
      </div>

      {/* Row 2: folder (single) + 5 个标签维度 */}
      <div className="grid grid-cols-3 gap-2">
        <MultiSelectPopover
          label="子目录"
          options={folderOptions}
          selected={value.folder_prefix ? [value.folder_prefix] : []}
          onChange={setFolderPrefix}
          single
          searchable
          disabled={!projectId}
          disabledHint="未选择项目"
        />
        {(Object.keys(TAG_DIM_LABELS) as (keyof CandidateFilters['tags'])[]).slice(0, 2).map((dim) => (
          <TagDimensionSelect
            key={dim}
            dim={dim}
            schema={schema}
            value={value.tags[dim] || []}
            onChange={(vals) => setTagDim(dim, vals)}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(TAG_DIM_LABELS) as (keyof CandidateFilters['tags'])[]).slice(2).map((dim) => (
          <TagDimensionSelect
            key={dim}
            dim={dim}
            schema={schema}
            value={value.tags[dim] || []}
            onChange={(vals) => setTagDim(dim, vals)}
          />
        ))}
      </div>

      {/* Row 3: image_id 白名单（折叠） */}
      <ImageIdsRow value={value} onChange={onChange} />
    </div>
  )
}

// ── segmented buttons (radio): source_type ───────────────────────────────
function SegmentedSourceType({
  value, onChange,
}: { value: CandidateFilters['source_type']; onChange: (v: CandidateFilters['source_type']) => void }) {
  const opts = ['all', 'original', 'generated'] as const
  return (
    <div className="inline-flex h-7 rounded-md border border-foreground/10 overflow-hidden divide-x divide-foreground/10">
      {opts.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cn(
            'flex-1 px-2 text-[11.5px] transition-colors',
            value === id
              ? 'bg-accent/15 text-accent font-medium'
              : 'text-foreground/60 hover:bg-foreground/[0.03]',
          )}
        >
          {SOURCE_TYPE_LABEL[id]}
        </button>
      ))}
    </div>
  )
}

// ── tag dimension dropdown ───────────────────────────────────────────────
function TagDimensionSelect({
  dim, schema, value, onChange,
}: {
  dim: keyof CandidateFilters['tags']
  schema?: Record<string, { label: string; values: string[] }>
  value: string[]
  onChange: (v: string[]) => void
}) {
  const meta = schema?.[dim as string]
  const opts: MultiSelectOption[] = useMemo(() => {
    if (!meta) return []
    return meta.values.map((v) => ({ value: v, label: v }))
  }, [meta])
  return (
    <MultiSelectPopover
      label={TAG_DIM_LABELS[dim]}
      options={opts}
      selected={value}
      onChange={onChange}
      searchable={(meta?.values?.length || 0) > 8}
    />
  )
}

// ── image_id whitelist (paste / chip / clear) ────────────────────────────
function ImageIdsRow({
  value, onChange,
}: { value: CandidateFilters; onChange: (n: CandidateFilters) => void }) {
  const [paste, setPaste] = useState('')
  const [open, setOpen] = useState(value.image_ids.length > 0)

  const addPasted = () => {
    const ids = Array.from(new Set(
      paste.split(/[\s,，\n]+/).map((s) => s.trim()).filter(Boolean)
    ))
    if (ids.length === 0) return
    const merged = Array.from(new Set([...value.image_ids, ...ids]))
    onChange({ ...value, image_ids: merged })
    setPaste('')
  }

  const remove = (id: string) =>
    onChange({ ...value, image_ids: value.image_ids.filter((x) => x !== id) })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] text-foreground/55 hover:text-foreground/85"
      >
        <Plus size={11} />
        图片 ID 白名单（强约束）
      </button>
    )
  }

  return (
    <div className="rounded-md border border-foreground/10 p-2 space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="inline-flex items-center gap-1 text-foreground/65 font-medium">
          图片 ID 白名单
          <InfoHint text="只在这些 image_id 里召回 + 评分；其它过滤条件仍叠加。粘贴/手填 ID 列表后回车或点添加。" />
        </span>
        <button
          type="button"
          onClick={() => { setOpen(false); onChange({ ...value, image_ids: [] }) }}
          className="text-foreground/40 hover:text-destructive"
        >
          收起并清空
        </button>
      </div>
      <div className="flex gap-1.5">
        <Input
          value={paste}
          placeholder="粘贴 image_id（多个用逗号 / 空格 / 换行分隔）"
          onChange={(e) => setPaste(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPasted() } }}
          className="h-7 text-[11px] flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={addPasted}
          disabled={!paste.trim()}
        >
          添加
        </Button>
      </div>
      {value.image_ids.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
          {value.image_ids.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-mono border border-accent/20"
            >
              {id.length > 12 ? `${id.slice(0, 8)}…` : id}
              <button type="button" onClick={() => remove(id)} className="opacity-70 hover:opacity-100">
                <X size={9} />
              </button>
            </span>
          ))}
          <span className="text-[10px] text-foreground/40 ml-1">共 {value.image_ids.length} 个</span>
        </div>
      )}
    </div>
  )
}

// ── shared ──────────────────────────────────────────────────────────────
export function countActive(f: CandidateFilters): number {
  let n = 0
  if (f.source_type !== 'all') n++
  if (f.prompt_ids.length > 0) n++
  if (f.folder_prefix) n++
  for (const v of Object.values(f.tags)) {
    if (v && v.length > 0) n++
  }
  if (f.image_ids.length > 0) n++
  return n
}
