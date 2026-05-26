import { useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Sparkles } from 'lucide-react'

import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { api, ApiError, apiFetchRaw } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { CandidateFiltersPanel, EMPTY_FILTERS, countActive, type CandidateFilters } from './CandidateFilters'
import { SyncStatusBanner } from './SyncStatusBanner'
import { ConfigAuditTimeline } from './ConfigAuditTimeline'

/**
 * 「匹配策略」Tab — 上线前的运营配置面板。
 *
 * 这一套设置原本分散在 设置→匹配策略 + 试匹配的内嵌过滤器里，2026-05-07 整合到
 * 一个 Tab 内：策略权重 + 候选源约束 = 完整的「线上 UGC 调匹配 API 时的默认行为」。
 *
 * 流程：
 *   1. 运营在这里配 → 保存
 *   2. 桌面端写 config.json 同时入 cloud_sync_jobs 队列
 *   3. ~30 秒内云端 sidecar pull 到新配置，下次 UGC 调用立即生效
 *
 * UGC 端无需修改任何代码 — 它继续打 /open-api/v1/images/match，参数为 None 时
 * 后端自动用本面板设置的默认值（caller 显式传值仍然 override）。
 */

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
  const projectId = useAtomValue(activeProjectIdAtom)

  const { data: config, isLoading } = useQuery<Record<string, any>>({
    queryKey: ['config'],
    queryFn: () => api.config.get() as any,
  })
  const { data: syncStatus } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.config.syncStatus(),
    staleTime: 30_000,
  })

  const [strategy, setStrategy] = useState<Strategy>('balanced')
  const [diversity, setDiversity] = useState<Diversity>('balanced')
  const [randomness, setRandomness] = useState<string>('0.4')
  const [uniquePerSource, setUniquePerSource] = useState<boolean>(true)
  const [noPeople, setNoPeople] = useState<boolean>(true)
  const [cooldownSize, setCooldownSize] = useState<string>('20')
  const [seasonalBoost, setSeasonalBoost] = useState<string>('0.05')
  const [filters, setFilters] = useState<CandidateFilters>(EMPTY_FILTERS)

  // Hydrate form from server config when first loaded OR when project changes.
  // 优先级:项目级(match_per_project_<pid>)→ 全局(match_default_*)→ hardcoded
  useEffect(() => {
    if (!config) return
    const projKey = projectId ? `match_per_project_${projectId}` : ''
    const projCfg = (projKey && config[projKey] && typeof config[projKey] === 'object'
                     && !Array.isArray(config[projKey])) ? config[projKey] : {}

    // helper: 项目级取 base_key,fallback 全局 match_default_<base_key>
    const pick = (baseKey: string, globalKey: string) => {
      if (projCfg[baseKey] !== undefined && projCfg[baseKey] !== null && projCfg[baseKey] !== '') {
        return projCfg[baseKey]
      }
      return config[globalKey]
    }

    const s = String(pick('strategy', 'match_default_strategy') || 'balanced').toLowerCase()
    setStrategy((['balanced','precise','diverse'].includes(s) ? s : 'balanced') as Strategy)
    const d = String(pick('diversity', 'match_default_diversity') || 'balanced').toLowerCase()
    setDiversity((['balanced','strict','none'].includes(d) ? d : 'balanced') as Diversity)
    const r = pick('randomness', 'match_default_randomness')
    setRandomness(r === undefined || r === null || r === '' ? '0.4' : String(r))
    const u = pick('unique_per_source', 'match_default_unique_per_source')
    setUniquePerSource(u === undefined ? true : Boolean(u) && String(u).toLowerCase() !== 'false')
    const np = pick('no_people', 'match_default_no_people')
    setNoPeople(np === undefined ? true : Boolean(np) && String(np).toLowerCase() !== 'false')
    const cd = pick('recent_cooldown_size', 'match_recent_cooldown_size')
    setCooldownSize(cd === undefined || cd === null || cd === '' ? '20' : String(cd))
    const sb = pick('seasonal_boost_strength', 'match_seasonal_boost_strength')
    setSeasonalBoost(sb === undefined || sb === null || sb === '' ? '0.05' : String(sb))

    // 候选源 filter — 项目级取 projCfg.filters,fallback 全局 match_default_filters
    const rawFilters = projCfg.filters !== undefined ? projCfg.filters : config['match_default_filters']
    let parsed: any = null
    if (rawFilters && typeof rawFilters === 'object' && !Array.isArray(rawFilters)) {
      parsed = rawFilters
    } else if (typeof rawFilters === 'string' && rawFilters.trim()) {
      try { parsed = JSON.parse(rawFilters) } catch { parsed = null }
    }
    setFilters({
      source_type:
        parsed?.source_type === 'original' || parsed?.source_type === 'generated'
          ? parsed.source_type
          : 'all',
      prompt_ids: Array.isArray(parsed?.prompt_ids) ? parsed.prompt_ids : [],
      folder_prefix: typeof parsed?.folder_prefix === 'string' && parsed.folder_prefix ? parsed.folder_prefix : null,
      tags: parsed?.tags && typeof parsed.tags === 'object' ? parsed.tags : {},
      image_ids: Array.isArray(parsed?.image_ids) ? parsed.image_ids : [],
    })
  }, [config, projectId])

  const filterActiveCount = useMemo(() => countActive(filters), [filters])

  // 加载时拿到的版本号 — 保存时回传给后端做乐观锁。每次 query 重新拉时
  // 这个 hook 会跟着更新；冲突解决后用户再点保存自动用新值。
  const loadedVersion = useMemo<number | undefined>(() => {
    const v = config?.['__version']
    return typeof v === 'number' ? v : undefined
  }, [config])

  const [conflict, setConflict] = useState<null | {
    expected: number
    current: number
    pending: Record<string, unknown>
  }>(null)

  const saveMutation = useMutation({
    mutationFn: ({ payload, ifVersion }: { payload: Record<string, any>; ifVersion?: number }) =>
      api.config.update(payload, ifVersion),
    onSuccess: () => {
      setConflict(null)
      if (syncStatus?.enabled) {
        toast.success('已保存 — 已入云端同步队列，UGC 30s 内生效')
      } else {
        toast.success('已保存到本地 — 不会影响线上 UGC')
      }
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
    onError: (e: unknown, vars) => {
      if (e instanceof ApiError && e.status === 409) {
        const detail = (e.body as any)?.detail || e.body
        if (detail?.code === 'version_conflict') {
          setConflict({
            expected: detail.expected_version,
            current: detail.current_version,
            pending: vars.payload,
          })
          return
        }
      }
      toast.error(`保存失败：${(e as Error)?.message || e}`)
    },
  })

  const handleSave = () => {
    const r = Math.max(0, Math.min(1, Number(randomness) || 0))
    const cd = Math.max(0, Math.min(500, Math.floor(Number(cooldownSize) || 0)))
    const sb = Math.max(0, Math.min(0.5, Number(seasonalBoost) || 0))

    // 候选源序列化：剔除空集合，让 config.json 不堆冗余字段
    const filterPayload: Record<string, unknown> = {}
    if (filters.source_type !== 'all') filterPayload.source_type = filters.source_type
    if (filters.prompt_ids.length > 0) filterPayload.prompt_ids = filters.prompt_ids
    if (filters.folder_prefix)         filterPayload.folder_prefix = filters.folder_prefix
    if (filters.image_ids.length > 0)  filterPayload.image_ids = filters.image_ids
    const tagPayload: Record<string, string[]> = {}
    for (const [dim, vals] of Object.entries(filters.tags)) {
      if (vals && vals.length > 0) tagPayload[dim] = vals
    }
    if (Object.keys(tagPayload).length > 0) filterPayload.tags = tagPayload

    // 项目级 payload(单 key 写整个项目 dict,不影响其他项目)
    // base_key 不带 match_default_ 前缀(项目级简写)
    const projectPayload = {
      strategy,
      diversity,
      randomness: r,
      unique_per_source: uniquePerSource,
      no_people: noPeople,
      recent_cooldown_size: cd,
      seasonal_boost_strength: sb,
      filters: filterPayload,
    }
    const payload: Record<string, any> = projectId
      ? { [`match_per_project_${projectId}`]: projectPayload }
      : {
          // 没选项目 → 兼容老行为写全局(理论上 ProjectSelector 必选,这只是兜底)
          match_default_strategy: strategy,
          match_default_diversity: diversity,
          match_default_randomness: r,
          match_default_unique_per_source: uniquePerSource,
          match_default_no_people: noPeople,
          match_recent_cooldown_size: cd,
          match_seasonal_boost_strength: sb,
          match_default_filters: filterPayload,
        }
    saveMutation.mutate({ payload, ifVersion: loadedVersion })
  }

  /** 用户在冲突弹窗里点了「强制覆盖」— 强制提交，不带 ifVersion 跳过乐观锁 */
  const handleForceOverwrite = () => {
    if (!conflict) return
    saveMutation.mutate({ payload: conflict.pending })
  }

  /** 「丢弃我的改动，刷新到云端版本」— 重新拉一次 config */
  const handleDiscardLocal = () => {
    setConflict(null)
    queryClient.invalidateQueries({ queryKey: ['config'] })
    toast('已丢弃本地未保存改动，加载云端最新版本')
  }

  const handleResetCooldown = async () => {
    try {
      const r = await apiFetchRaw('/config/match-cooldown/reset', { method: 'POST' })
      const data = await r.json()
      toast.success(`已清空 cooldown — 释放 ${data.cleared} 个 image_id`)
    } catch (e: any) {
      toast.error(`清空失败：${e?.message || e}`)
    }
  }

  if (isLoading) {
    return <div className="text-[12px] text-foreground/40">加载配置…</div>
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* 必须摆在最前面：操作者必须先看到"我是不是会改线上" */}
      <SyncStatusBanner />

      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3 text-[12px] text-foreground/65 leading-relaxed flex items-start gap-2">
        <Sparkles size={14} className="text-accent shrink-0 mt-0.5" />
        <div>
          <strong className="text-foreground/85">线上匹配策略</strong>
          ：配好这里的参数，UGC 调
          <code className="px-1 mx-0.5 bg-foreground/[0.05] rounded text-[11px]">/open-api/v1/images/match</code>
          时不传任何字段就自动用这套配置（caller 显式传值仍然覆盖）。
          要先临时看效果 → 切到「<strong>试匹配</strong>」Tab 实验。
        </div>
      </div>

      {/* ── 排序 / 调度 ─────────────────────────────────────────────── */}
      <Group title="排序与调度" hint="决定结果怎么打分、怎么去重、随机度多少 — 影响每次 UGC 调用返回的 8 张图的顺序与组合。">

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
          <SliderRow value={randomness} onChange={setRandomness} min={0} max={1} step={0.05} />
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

        <Section title="季节加成 (seasonal_boost)" hint="按当前月份推算季节，命中该季节标签的图额外加 boost 分。0 = 关闭；0.05 = 推荐；0.15 = 季节强相关（春节 / 国庆这种营销期可临时调高）。">
          <SliderRow value={seasonalBoost} onChange={setSeasonalBoost} min={0} max={0.3} step={0.01} />
        </Section>

        <Section title="近期排除窗口 (recent_cooldown)" hint="服务端为每个景区维护一个滑动队列：最近返回过的 N 张图，之后的匹配自动排除，直到它们滑出队列。专门解决「UGC 文案重复 → 永远是这几张图」的问题。0 = 关闭；20 = 最近 20 张静默期；500 上限。">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={cooldownSize}
              onChange={(e) => setCooldownSize(e.target.value)}
              className="flex-1 max-w-[280px] accent-accent"
            />
            <Input
              type="number"
              min="0"
              max="500"
              step="1"
              value={cooldownSize}
              onChange={(e) => setCooldownSize(e.target.value)}
              className="w-20 h-8 text-[12px]"
            />
            <Button size="sm" variant="outline" onClick={handleResetCooldown} title="立即清空所有项目的 cooldown 队列（不影响配置值）">
              清空缓冲
            </Button>
          </div>
        </Section>
      </Group>

      {/* ── 候选源 ─────────────────────────────────────────────── */}
      <Group
        title="候选源（线上默认）"
        hint="把 UGC 召回的候选池约束到资产库的子集 — 用来上线前限定「只返回 X 套 prompt 生成的春季图」之类。caller 在调用时如果显式传了 filters，仍然以 caller 为准。"
        badge={filterActiveCount > 0 ? `${filterActiveCount} 项过滤生效` : '默认全库'}
      >
        <CandidateFiltersPanel
          value={filters}
          onChange={setFilters}
          projectId={projectId ?? null}
        />
      </Group>

      {/* ── 审计 ─────────────────────────────────────────────── */}
      <ConfigAuditTimeline />

      {/* ── 冲突解决 ──────────────────────────────────────────── */}
      <Dialog open={!!conflict} onOpenChange={(o) => { if (!o) setConflict(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle size={16} />
              另一处刚改过这份配置
            </DialogTitle>
            <DialogDescription>
              你看到的版本是 <code className="font-mono">{conflict?.expected}</code>
              ，但服务端当前版本已经是 <code className="font-mono">{conflict?.current}</code>
              ，可能是另一台运营机器（或同事）刚保存了。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-[12.5px] text-foreground/70 leading-relaxed">
            <p>你可以选择：</p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>强制覆盖</strong>：用你当前页面的修改覆盖云端 — 对方刚改的会丢失</li>
              <li><strong>丢弃我的修改</strong>：放弃你这次的调整，重新加载云端最新值</li>
              <li>关闭对话框：保留本地修改，先去看看「最近修改」时间线再决定</li>
            </ul>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" size="sm" onClick={handleDiscardLocal}>
              丢弃我的修改
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConflict(null)}>
              先看看
            </Button>
            <Button
              size="sm"
              onClick={handleForceOverwrite}
              className="bg-amber-600 hover:bg-amber-700"
            >
              强制覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 保存 ─────────────────────────────────────────────── */}
      <div className="pt-2 flex items-center gap-3 sticky bottom-0 bg-background py-3 border-t border-foreground/5">
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? '保存中…' : '保存匹配策略'}
        </Button>
        <span className="text-[11px] text-foreground/45">
          {syncStatus?.enabled
            ? '保存后入云端同步队列，UGC ~30s 内生效'
            : '当前是「只本地」模式 — 保存仅写入本机配置，不会影响 UGC'}
        </span>
      </div>
    </div>
  )
}

// ── small inline UI helpers ───────────────────────────────────────────────────

function Group({
  title, hint, badge, children,
}: { title: string; hint?: string; badge?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-foreground/5 p-4 space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-[13.5px] font-semibold text-foreground/85">{title}</h3>
          {hint && <p className="text-[11px] text-foreground/50 mt-0.5 leading-relaxed">{hint}</p>}
        </div>
        {badge && (
          <span className="text-[10.5px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent shrink-0">
            {badge}
          </span>
        )}
      </header>
      {children}
    </section>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-2">
        <h4 className="text-[12.5px] font-medium text-foreground/80">{title}</h4>
        <InfoHint text={hint} />
      </div>
      {children}
    </section>
  )
}

function SliderRow({
  value, onChange, min, max, step,
}: { value: string; onChange: (v: string) => void; min: number; max: number; step: number }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 max-w-[280px] accent-accent"
      />
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 h-8 text-[12px]"
      />
    </div>
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
