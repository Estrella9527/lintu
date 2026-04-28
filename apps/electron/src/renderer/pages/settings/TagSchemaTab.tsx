import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { FlaskConical, X, Plus, RefreshCw } from 'lucide-react'
import { activeModuleAtom, matchLabNavRequestAtom } from '@/atoms/navigation'
import { matchLabActiveTabAtom } from '@/atoms/ui-state'

interface DimensionSchema {
  label: string
  values: string[]
  required?: boolean
  multi?: boolean
}

type SchemaData = Record<string, DimensionSchema>

async function fetchSchema(): Promise<SchemaData> {
  const res = await fetch('http://localhost:7879/api/tag-schema')
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  const data = await res.json()
  // Validate shape
  if (!data || typeof data !== 'object') throw new Error('Invalid schema format')
  return data as SchemaData
}

export function TagSchemaTab() {
  const queryClient = useQueryClient()
  const { data: schema, isLoading, error, refetch } = useQuery<SchemaData>({
    queryKey: ['tag-schema'],
    queryFn: fetchSchema,
    retry: 2,
    retryDelay: 1000,
  })

  const { data: usage } = useQuery<Record<string, Record<string, number>>>({
    queryKey: ['tag-schema-usage'],
    queryFn: () => fetch('http://localhost:7879/api/tag-schema/usage').then((r) => r.json()),
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3 max-w-2xl">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-foreground/[0.02] animate-pulse" />
        ))}
      </div>
    )
  }

  if (error || !schema || Object.keys(schema).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <p className="text-[13px] text-foreground/40">
          {error ? `加载失败: ${(error as Error).message}` : '标签体系为空'}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw size={12} className="mr-1.5" /> 重试
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <p className="text-[12px] text-foreground/40">
        管理标签维度及其预设值。修改后将影响 AI 打标的输出范围和覆盖矩阵的维度选项。
      </p>
      {Object.entries(schema)
        .filter(([, def]) => def && Array.isArray(def.values))
        .map(([dim, def]) => (
          <DimensionCard
            key={dim}
            dimension={dim}
            schema={def}
            usage={usage?.[dim] ?? null}
            onChanged={() => {
              queryClient.invalidateQueries({ queryKey: ['tag-schema'] })
              queryClient.invalidateQueries({ queryKey: ['tag-schema-usage'] })
            }}
          />
        ))}

      <SynonymsTombstone />
    </div>
  )
}

/** Old "同义词" card lived here. The feature moved to 匹配实验室 →
 * 同义词. We leave a one-click jump for users who came looking by old
 * habit; can be deleted in a later cleanup pass once everyone has
 * migrated. */
function SynonymsTombstone() {
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setMatchLabTab = useSetAtom(matchLabActiveTabAtom)
  const setMatchLabNav = useSetAtom(matchLabNavRequestAtom)
  const goToMatchLab = () => {
    setMatchLabTab('synonyms')
    setMatchLabNav({ tab: 'synonyms' })
    setActiveModule('match-lab')
  }
  return (
    <div className="rounded-lg border border-dashed border-foreground/10 p-3 flex items-center gap-2 text-[11.5px] text-foreground/45">
      <FlaskConical size={13} className="text-foreground/40 shrink-0" />
      <span>同义词管理已迁至「匹配实验室 → 同义词」</span>
      <Button
        variant="ghost" size="sm"
        className="h-6 text-[11px] ml-auto text-accent hover:text-accent"
        onClick={goToMatchLab}
      >
        前往 →
      </Button>
    </div>
  )
}

function DimensionCard({ dimension, schema, usage, onChanged }: {
  dimension: string
  schema: DimensionSchema
  usage: Record<string, number> | null
  onChanged: () => void
}) {
  const [newValue, setNewValue] = useState('')
  const totalHits = usage ? Object.values(usage).reduce((s, n) => s + n, 0) : 0
  const peakHits = usage ? Math.max(1, ...Object.values(usage)) : 1

  const addMutation = useMutation({
    mutationFn: (value: string) =>
      fetch(`http://localhost:7879/api/tag-schema/${dimension}/values`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      }).then((r) => r.json()),
    onSuccess: () => { setNewValue(''); onChanged() },
  })

  const removeMutation = useMutation({
    mutationFn: (value: string) =>
      fetch(`http://localhost:7879/api/tag-schema/${dimension}/${encodeURIComponent(value)}`, {
        method: 'DELETE',
      }).then((r) => r.json()),
    onSuccess: onChanged,
  })

  const handleAdd = () => {
    const v = newValue.trim()
    if (!v) return
    if (schema.values.includes(v)) { toast.error('该值已存在'); return }
    addMutation.mutate(v)
  }

  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[13px] font-medium text-foreground/80">{schema.label}</h3>
        <span className="text-[11px] text-foreground/30">({dimension})</span>
        {schema.required && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/40">必选</Badge>
        )}
        {schema.multi && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/40">多选</Badge>
        )}
        <span className="text-[11px] text-foreground/30 ml-auto">
          {schema.values.length} 个值{totalHits > 0 ? ` · 命中 ${totalHits.toLocaleString()} 次` : ''}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {schema.values.map((v) => {
          const n = usage?.[v] ?? 0
          // Color encoding: 0 = stale (gray-strike), low = warning, normal = neutral, high = accent.
          const ratio = peakHits > 0 ? n / peakHits : 0
          const tone =
            usage == null ? 'neutral' :
            n === 0 ? 'dead' :
            ratio >= 0.5 ? 'hot' :
            ratio >= 0.1 ? 'normal' :
            'cold'
          return (
            <span
              key={v}
              className={
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] group ' +
                (tone === 'dead' ? 'bg-foreground/[0.02] text-foreground/30 line-through decoration-foreground/20' :
                 tone === 'cold' ? 'bg-foreground/[0.04] text-foreground/55' :
                 tone === 'hot'  ? 'bg-accent/10 text-accent' :
                 'bg-foreground/[0.04] text-foreground/70')
              }
              title={usage == null ? v : `${v} · 命中 ${n.toLocaleString()} 张图`}
            >
              {v}
              {usage != null && (
                <span className={
                  'tabular-nums text-[10px] ' +
                  (tone === 'dead' ? 'text-foreground/30' :
                   tone === 'hot'  ? 'text-accent/85' :
                                     'text-foreground/40')
                }>
                  {n}
                </span>
              )}
              <button
                onClick={() => removeMutation.mutate(v)}
                className="opacity-0 group-hover:opacity-100 text-foreground/30 hover:text-destructive transition-opacity"
              >
                <X size={10} />
              </button>
            </span>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="添加新值..."
          className="h-7 text-[12px] flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          disabled={!newValue.trim()}
          onClick={handleAdd}
        >
          <Plus size={12} className="mr-1" /> 添加
        </Button>
      </div>
    </div>
  )
}
