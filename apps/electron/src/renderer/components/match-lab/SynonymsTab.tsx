import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ArrowRight, Plus, X } from 'lucide-react'

const API = 'http://localhost:7879/api/match-synonyms'

/**
 * Synonym dictionary editor — alias → canonical map applied before jieba
 * tokenization in the keyword-extraction step. Lets ops normalize colloquial
 * phrases ("傍晚" → "黄昏") so keyword recall hits the canonical tag value.
 *
 * Lives in the Match Lab now. Used to be a card in 设置 → 标签体系.
 */
export function SynonymsTab() {
  const queryClient = useQueryClient()
  const { data } = useQuery<{ entries: Record<string, string> }>({
    queryKey: ['match-synonyms'],
    queryFn: () => fetch(API).then((r) => r.json()),
  })
  const entries = data?.entries ?? {}
  const [alias, setAlias] = useState('')
  const [canonical, setCanonical] = useState('')

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['match-synonyms'] })

  const addM = useMutation({
    mutationFn: (body: { alias: string; canonical: string }) =>
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (r) => {
        if (!r.ok) throw new Error(await r.text())
        return r.json()
      }),
    onSuccess: () => { setAlias(''); setCanonical(''); invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const delM = useMutation({
    mutationFn: (a: string) =>
      fetch(`${API}/${encodeURIComponent(a)}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: invalidate,
  })

  const onAdd = () => {
    const a = alias.trim(); const c = canonical.trim()
    if (!a || !c) return
    if (a === c) { toast.error('alias 必须和 canonical 不同'); return }
    addM.mutate({ alias: a, canonical: c })
  }

  const sorted = Object.entries(entries).sort((a, b) => a[0].localeCompare(b[0], 'zh'))

  return (
    <div className="max-w-3xl space-y-3">
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3 text-[12px] text-foreground/65 leading-relaxed">
        把用户口语化的词映射到标签维度里的标准值，让关键词召回更准。
        例如把 <code className="px-1 bg-foreground/[0.05] rounded">傍晚</code> →
        <code className="px-1 bg-foreground/[0.05] rounded">黄昏</code>，匹配链路在 jieba 分词前先做替换。
        内置词典（春天 → 春季、孩子 → 儿童…）随系统升级；这里加的是<strong>项目专属覆盖</strong>，保存即刻生效。
      </div>

      <div className="rounded-lg border border-foreground/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-[13px] font-medium text-foreground/80">同义词映射</h3>
          <span className="text-[11px] text-foreground/35">
            alias → canonical
          </span>
          <span className="ml-auto text-[11px] text-foreground/30">
            {Object.keys(entries).length} 条自定义
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {sorted.length === 0 ? (
            <span className="text-[11px] text-foreground/35">暂无自定义条目，输入并保存即可生效</span>
          ) : sorted.map(([a, c]) => (
            <span
              key={a}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-foreground/[0.04] text-[12px] text-foreground/75 group"
            >
              <span>{a}</span>
              <ArrowRight size={10} className="text-foreground/30" />
              <span className="text-accent">{c}</span>
              <button
                onClick={() => delM.mutate(a)}
                className="opacity-0 group-hover:opacity-100 text-foreground/30 hover:text-destructive transition-opacity"
                title="删除"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="alias（用户口语，如「傍晚」）"
            className="h-7 text-[12px] flex-1"
          />
          <ArrowRight size={12} className="self-center text-foreground/30" />
          <Input
            value={canonical}
            onChange={(e) => setCanonical(e.target.value)}
            placeholder="canonical（标签值，如「黄昏」）"
            className="h-7 text-[12px] flex-1"
            onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            disabled={!alias.trim() || !canonical.trim() || addM.isPending}
            onClick={onAdd}
          >
            <Plus size={12} className="mr-1" /> 添加
          </Button>
        </div>
      </div>
    </div>
  )
}
