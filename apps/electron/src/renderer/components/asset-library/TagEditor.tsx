import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'

import { api, apiFetchRaw } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { TagRecord } from '@/lib/types'

type DimSchema = { label?: string; required?: boolean; multi?: boolean; values?: string[] }
type Schema = Record<string, DimSchema>

/** 单图人工打标编辑器。AI 标签(描边+✦)与人工标签(实心 accent)视觉区分,
 * 每个标签可删(纠正 AI 错标);「加标签」只能从标签体系枚举里选(受控)。
 * 增删走非破坏式端点,不影响其它维度。 */
export function TagEditor({ imageId, tags }: { imageId: string; tags: TagRecord[] }) {
  const qc = useQueryClient()
  const { data: schema } = useQuery<Schema>({
    queryKey: ['tag-schema'],
    queryFn: () => apiFetchRaw('/tag-schema').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['image-detail', imageId] })
    qc.invalidateQueries({ queryKey: ['images'] })
  }
  const addMut = useMutation({
    mutationFn: (p: { dimension: string; value: string }) => api.images.addTag(imageId, p.dimension, p.value),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.message || '加标签失败'),
  })
  const delMut = useMutation({
    mutationFn: (tagId: string) => api.images.removeTag(imageId, tagId),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.message || '删标签失败'),
  })

  const byDim: Record<string, TagRecord[]> = {}
  for (const t of tags) (byDim[t.dimension] ??= []).push(t)
  const dimLabel = (d: string) => schema?.[d]?.label || d

  return (
    <div className="col-span-2 space-y-2">
      {Object.entries(byDim).map(([dim, ts]) => (
        <div key={dim} className="flex items-start gap-2">
          <span className="text-[10px] text-foreground/40 w-12 shrink-0 pt-1">{dimLabel(dim)}</span>
          <div className="flex flex-wrap gap-1">
            {ts.map((t) => (
              <span
                key={t.id}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] border',
                  t.source === 'manual'
                    ? 'bg-accent/15 text-accent border-accent/30'
                    : 'bg-foreground/[0.04] text-foreground/70 border-foreground/10',
                )}
                title={t.source === 'manual' ? '人工标注' : 'AI 标注'}
              >
                {t.source === 'ai' && <Sparkles size={8} className="opacity-50" />}
                {t.value}
                <button
                  type="button"
                  onClick={() => delMut.mutate(t.id)}
                  className="ml-0.5 opacity-40 hover:opacity-100 hover:text-destructive"
                  title="删除该标签"
                >
                  <X size={9} />
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}

      {schema && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-6 text-[10px] px-2 gap-1 text-foreground/60">
              <Plus size={10} /> 加标签
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[320px] max-h-[420px] p-0 overflow-hidden flex flex-col" align="start">
            <div className="px-3 py-2 border-b border-foreground/8 text-[11px] font-medium text-foreground/70">
              选标签 <span className="text-foreground/40 font-normal">· 仅限标签体系内取值</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2.5">
              {Object.entries(schema).map(([dim, ds]) => (
                <div key={dim}>
                  <div className="text-[10px] text-foreground/45 mb-1">
                    {ds.label || dim}{ds.multi ? '' : ' · 单选'}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(ds.values || []).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => addMut.mutate({ dimension: dim, value: v })}
                        className="rounded px-1.5 py-0.5 text-[10px] border border-foreground/10 hover:border-accent/40 hover:text-accent hover:bg-accent/5"
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
