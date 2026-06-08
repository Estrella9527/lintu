import { useQuery } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { Palette } from 'lucide-react'

import { apiFetchRaw } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'

export interface StyleArchive {
  id: string
  project_id: string
  name: string
  description: string
  ref_image_ids: string[]
  strength_default: number
  params: Record<string, unknown>
}

interface StyleArchivePickerProps {
  value: string | null
  onChange: (id: string | null) => void
  /** 控制是否显示 label;紧凑场景(PromptBar)关掉 */
  showLabel?: boolean
}

/**
 * 风格档案选择器 — 通用组件,画布右面板 / Prompt 栏 / 批量配置 Step2 都复用。
 *
 * Phase 1 直接用 native select 求快。未来 Phase 2 可加缩略图预览(展示 ref_image_ids 头一张)。
 */
export function StyleArchivePicker({ value, onChange, showLabel = true }: StyleArchivePickerProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const { data } = useQuery<{ items: StyleArchive[] }>({
    queryKey: ['style-archives', projectId],
    queryFn: () => apiFetchRaw(`/style-archives?project_id=${projectId}`).then((r) => r.json()),
    enabled: !!projectId,
  })
  const items = data?.items || []

  return (
    <div className="inline-flex flex-col flex-1 min-w-0">
      {showLabel && (
        <span className="text-[9.5px] text-foreground/40 ml-1 inline-flex items-center gap-1">
          <Palette size={9} /> 风格档案
        </span>
      )}
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-7 px-1.5 rounded-md border border-foreground/12 bg-background
                   text-[11.5px] text-foreground/75
                   focus:outline-none focus:ring-1 focus:ring-accent/40"
        title={items.length === 0 ? '尚未创建任何风格档案(去 设置 → 风格档案)' : '应用风格档案保证跨图一致性'}
      >
        <option value="">不应用</option>
        {items.map((it) => (
          <option key={it.id} value={it.id}>{it.name}</option>
        ))}
      </select>
    </div>
  )
}
