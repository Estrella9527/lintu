import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'

type Strategy = 'balanced' | 'precise' | 'diverse'
type Diversity = 'balanced' | 'strict' | 'none'

const STRATEGY_OPTS: { v: Strategy; label: string; desc: string }[] = [
  { v: 'balanced', label: '平衡', desc: 'embedding + tag 并重，最常用' },
  { v: 'precise',  label: '精准', desc: 'embedding 主导，相关性优先' },
  { v: 'diverse',  label: '多样', desc: 'diversity 主导，结果分散' },
]
const DIVERSITY_OPTS: { v: Diversity; label: string; desc: string }[] = [
  { v: 'balanced', label: '平衡', desc: '同源/同标签 ≤2 张' },
  { v: 'strict',   label: '严格', desc: '所有维度 ≤1 张' },
  { v: 'none',     label: '不限', desc: '直接按分数返回，不去重' },
]

export function MatchStrategyTab() {
  const queryClient = useQueryClient()

  const { data: config, isLoading } = useQuery<Record<string, any>>({
    queryKey: ['config'],
    queryFn: () => api.config.get() as any,
  })

  const [strategy, setStrategy] = useState<Strategy>('balanced')
  const [diversity, setDiversity] = useState<Diversity>('balanced')
  const [randomness, setRandomness] = useState<string>('0.4')
  const [uniquePerSource, setUniquePerSource] = useState<boolean>(true)
  const [noPeople, setNoPeople] = useState<boolean>(true)

  // Hydrate form from server config when first loaded.
  useEffect(() => {
    if (!config) return
    const s = String(config['match_default_strategy'] || 'balanced').toLowerCase()
    setStrategy((['balanced','precise','diverse'].includes(s) ? s : 'balanced') as Strategy)
    const d = String(config['match_default_diversity'] || 'balanced').toLowerCase()
    setDiversity((['balanced','strict','none'].includes(d) ? d : 'balanced') as Diversity)
    const r = config['match_default_randomness']
    setRandomness(r === undefined || r === null || r === '' ? '0.4' : String(r))
    const u = config['match_default_unique_per_source']
    setUniquePerSource(u === undefined ? true : Boolean(u) && String(u).toLowerCase() !== 'false')
    const np = config['match_default_no_people']
    setNoPeople(np === undefined ? true : Boolean(np) && String(np).toLowerCase() !== 'false')
  }, [config])

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, any>) => api.config.update(payload),
    onSuccess: () => {
      toast.success('已保存匹配策略 — UGC 下次调用即生效；云端 30s 内同步')
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
    onError: (e: any) => toast.error(`保存失败：${e?.message || e}`),
  })

  const handleSave = () => {
    const r = Math.max(0, Math.min(1, Number(randomness) || 0))
    saveMutation.mutate({
      match_default_strategy: strategy,
      match_default_diversity: diversity,
      match_default_randomness: r,
      match_default_unique_per_source: uniquePerSource,
      match_default_no_people: noPeople,
    })
  }

  if (isLoading) {
    return <div className="text-[12px] text-foreground/40">加载配置…</div>
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <section>
        <h3 className="text-[13px] font-medium text-foreground/80 mb-1">匹配默认策略</h3>
        <p className="text-[11px] text-foreground/45 leading-relaxed">
          这里调好后，UGC 调 <code className="text-foreground/60">/open-api/v1/images/match</code> 时
          <b className="text-foreground/65">不需要传任何调优参数</b>，自动用这套配置。改完保存 → 30 秒内同步到云端。
        </p>
      </section>

      <Section title="策略 (strategy)" hint="决定 embedding / tag / quality / diversity / business 五个信号的权重组合。日常用「平衡」即可。">
        <ButtonGroup
          options={STRATEGY_OPTS}
          value={strategy}
          onChange={(v) => setStrategy(v as Strategy)}
        />
      </Section>

      <Section title="多样性 (diversity)" hint="结果的去重粒度。「严格」会让 8 张图全部来自不同原图族 + 不同标签组合，「不限」就只按分数返回。">
        <ButtonGroup
          options={DIVERSITY_OPTS}
          value={diversity}
          onChange={(v) => setDiversity(v as Diversity)}
        />
      </Section>

      <Section title="随机度 (randomness)" hint="0 = 同样的文案永远返回同样的图（适合需要稳定结果的场景）。0.3-0.5 = 用户每次刷新页面会看到不同组合（推荐生产值）。1 = 在分数相近的候选里大幅打乱。">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={randomness}
            onChange={(e) => setRandomness(e.target.value)}
            className="flex-1 max-w-[280px] accent-accent"
          />
          <Input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={randomness}
            onChange={(e) => setRandomness(e.target.value)}
            className="w-20 h-8 text-[12px]"
          />
        </div>
      </Section>

      <Section title="同源去重 (unique_per_source)" hint="开启时，同一张原图的所有 AI 风格化变体在结果里最多出现一张代表（按分数选最好的）。生产推荐开。">
        <ToggleButtons
          value={uniquePerSource}
          onLabel="开启 · 推荐"
          offLabel="关闭 · 允许 ≤2 张同源变体"
          onChange={setUniquePerSource}
        />
      </Section>

      <Section title="排除带人物 (no_people)" hint="开启时自动排除标签为「少量游客 / 人群 / 儿童 / 工作人员」的图。UGC 用户用自己的笔记找配图时，不希望出现陌生人脸 — 生产推荐开。">
        <ToggleButtons
          value={noPeople}
          onLabel="开启 · 仅返回无人景"
          offLabel="关闭 · 允许带人物"
          onChange={setNoPeople}
        />
      </Section>

      <div className="pt-2 flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? '保存中…' : '保存匹配策略'}
        </Button>
        <span className="text-[11px] text-foreground/40">保存后 UGC 端立即生效（无需 UGC 改代码）</span>
      </div>
    </div>
  )
}

// ── small inline UI helpers ───────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[12.5px] font-medium text-foreground/80 mb-1">{title}</h4>
      <p className="text-[11px] text-foreground/45 mb-2 leading-relaxed">{hint}</p>
      {children}
    </section>
  )
}

function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { v: T; label: string; desc: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          onClick={() => onChange(opt.v)}
          className={cn(
            'flex flex-col items-start gap-0.5 px-3 py-2 rounded-md border text-left transition-colors min-w-[180px]',
            value === opt.v
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-foreground/8 text-foreground/55 hover:bg-foreground/[0.03]',
          )}
        >
          <span className="text-[12px] font-medium">{opt.label}</span>
          <span className="text-[10px] text-foreground/45">{opt.desc}</span>
        </button>
      ))}
    </div>
  )
}

function ToggleButtons({
  value,
  onLabel,
  offLabel,
  onChange,
}: {
  value: boolean
  onLabel: string
  offLabel: string
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex gap-2">
      {([
        { v: true,  label: onLabel },
        { v: false, label: offLabel },
      ]).map((opt) => (
        <button
          key={String(opt.v)}
          type="button"
          onClick={() => onChange(opt.v)}
          className={cn(
            'px-3 py-2 rounded-md border text-[12px] transition-colors min-w-[180px] text-left',
            value === opt.v
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-foreground/8 text-foreground/55 hover:bg-foreground/[0.03]',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
