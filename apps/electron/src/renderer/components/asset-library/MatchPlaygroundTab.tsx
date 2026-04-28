import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, Copy as CopyIcon, Loader2, Sparkles, Star, Target } from 'lucide-react'
import { matchPlaygroundSeedAtom } from '@/atoms/match'
import { matchSourceFilterAtom, type MatchSourceFilter } from '@/atoms/ui-state'
import { activeProjectIdAtom } from '@/atoms/project'

const API_BASE = 'http://localhost:7879'

interface MatchedImage {
  image_id: string
  rank: number
  score: number
  score_breakdown: Record<string, number>
  embedding_sim: number
  matched_tags: { dimension: string; value: string }[]
  url: string
  thumbnail_url: string
  cdn_synced: boolean
  file_name: string
  width: number | null
  height: number | null
  source_type: string
  description: string | null
  tags: Record<string, string[]>
}

interface ScopeDecision {
  primary_project_id: string | null
  raw_signals: Record<string, number>
  weighted_signals: Record<string, number>
  weights: Record<string, number>
  selected_quota: Record<string, number>
}

interface MatchResponse {
  matches: (MatchedImage & { project_id?: string | null; is_primary_project?: boolean })[]
  took_ms: number
  scope_decision?: ScopeDecision
  debug: {
    kw_tokens: string[]
    expanded_keywords: string[]
    tag_hits: Record<string, string[]>
    recall_emb: number
    recall_kw: number
    candidates: number
    after_filters?: number
    weights?: Record<string, number>
    strategy?: string
    scope_decision?: ScopeDecision
  }
}

type StrategyId = 'precise' | 'balanced' | 'diverse'

const STRATEGY_OPTIONS: { id: StrategyId; label: string; desc: string }[] = [
  { id: 'precise', label: '严格', desc: 'embedding 主导，命中相关性高' },
  { id: 'balanced', label: '平衡（推荐）', desc: 'embedding + tag 综合打分' },
  { id: 'diverse', label: '多样', desc: '增大多样性惩罚，减少同源图' },
]

const SAMPLE_QUERIES = [
  '周末带孩子来这里玩，秋天的山地特别美',
  '梦幻浪漫的婚纱外景',
  '震撼的航拍山景，傍晚黄昏色调',
  '温馨亲子时光，孩子开心的笑容',
  '赛博朋克风格的夜景城市',
]

interface EvalQuery {
  id: string
  text: string
  tags: string[]
  ideal_image_ids: string[]
}

type SourceFilter = MatchSourceFilter

export function MatchPlaygroundTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [text, setText] = useState('')
  const [strategy, setStrategy] = useState<StrategyId>('balanced')
  const [limit, setLimit] = useState(8)
  const [diversity, setDiversity] = useState<'strict' | 'balanced' | 'none'>('balanced')
  const [sourceFilter, setSourceFilter] = useAtom(matchSourceFilterAtom)
  const [forceSingleProject, setForceSingleProject] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [useCustomWeights, setUseCustomWeights] = useState(false)
  const [w, setW] = useState({ embedding: 0.45, tag: 0.30, quality: 0.10, diversity: 0.10, business: 0.05 })
  const [showDebug, setShowDebug] = useState(true)

  // Load project list so the scope_decision UI can show readable names
  // instead of raw UUIDs.
  const { data: projects } = useQuery<{ id: string; name: string; color: string | null }[]>({
    queryKey: ['projects'],
    queryFn: () => fetch(`${API_BASE}/api/projects`).then((r) => r.json()),
    staleTime: 60_000,
  })
  const projectName = (id: string | null | undefined) =>
    (id && projects?.find((p) => p.id === id)?.name) || (id ? id.slice(0, 8) : '—')
  const projectColor = (id: string | null | undefined) =>
    (id && projects?.find((p) => p.id === id)?.color) || null

  // Eval-set: if the current text matches one of the 30 dataset queries
  // verbatim, we let the user mark results as ideal answers in-place.
  const { data: evalData } = useQuery<{ queries: EvalQuery[] }>({
    queryKey: ['match-eval-queries'],
    queryFn: () => fetch(`${API_BASE}/api/match/eval/queries`).then((r) => r.json()),
    staleTime: 30_000,
  })
  const matchedEvalQuery = useMemo<EvalQuery | null>(() => {
    if (!evalData?.queries || !text.trim()) return null
    const t = text.trim()
    return evalData.queries.find((q) => q.text === t) || null
  }, [evalData, text])
  const idealSet = useMemo(
    () => new Set(matchedEvalQuery?.ideal_image_ids || []),
    [matchedEvalQuery],
  )

  const idealMutation = useMutation({
    mutationFn: async ({ imageId, action }: { imageId: string; action: 'add' | 'remove' }) => {
      if (!matchedEvalQuery) throw new Error('未匹配到评估集 query')
      const res = await fetch(`${API_BASE}/api/match/eval/ideal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query_id: matchedEvalQuery.id, image_id: imageId, action }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (data) => {
      queryClient.setQueryData<{ queries: EvalQuery[] }>(['match-eval-queries'], (cur) => {
        if (!cur) return cur
        return {
          ...cur,
          queries: cur.queries.map((q) =>
            q.id === data.query_id ? { ...q, ideal_image_ids: data.ideal_image_ids } : q
          ),
        }
      })
    },
    onError: (e: Error) => toast.error(`保存失败：${e.message}`),
  })

  const matchMutation = useMutation({
    mutationFn: async (): Promise<MatchResponse> => {
      const body: any = { text, limit, strategy, diversity }
      if (useCustomWeights) body.weights = w
      if (sourceFilter !== 'all') body.filters = { source_type: sourceFilter }
      // Always inject the operator's currently-selected project as the
      // primary scope. This is what makes "搜漂流文本" return 漂流 images
      // instead of the cross-project soup the playground used to return.
      if (projectId) {
        body.scope = {
          primary_project_id: projectId,
          force_single_project: forceSingleProject,
        }
      }
      const res = await fetch(`${API_BASE}/open-api/v1/images/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any)?.error?.message || `HTTP ${res.status}`)
      }
      return res.json()
    },
    onError: (e: Error) => toast.error(`匹配失败：${e.message}`),
  })

  const onRun = () => {
    if (!text.trim()) {
      toast.error('请输入要匹配的文本')
      return
    }
    matchMutation.mutate()
  }

  // Cross-page hand-off: AnalyticsTab "复跑" pushes seed text here.
  const [seed, setSeed] = useAtom(matchPlaygroundSeedAtom)
  const autoRunRef = useRef(false)
  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    autoRunRef.current = !!seed.autoRun
    setSeed(null)
  }, [seed, setSeed])
  useEffect(() => {
    if (autoRunRef.current && text && !matchMutation.isPending) {
      autoRunRef.current = false
      matchMutation.mutate()
    }
  }, [text, matchMutation])

  const result = matchMutation.data

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Header */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3">
        <div className="flex items-start gap-2">
          <Sparkles size={14} className="text-foreground/55 shrink-0 mt-0.5" />
          <div className="text-[12px] text-foreground/65 leading-relaxed">
            <strong className="text-foreground/85">试匹配</strong>：直接调用 <code className="px-1 bg-foreground/[0.05] rounded text-[11px]">POST /open-api/v1/images/match</code>，
            和外部 UGC 应用走完全同一条链路。用来调试匹配效果、对比不同策略、找出召回缺口。
          </div>
        </div>
      </div>

      {/* Input + controls */}
      <div className="rounded-lg border border-foreground/8 p-4 space-y-3">
        <div>
          <label className="text-[12px] text-foreground/65 mb-1.5 block">查询文本</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入一段中文文本，例如：周末带孩子来这里玩，秋天的山地特别美"
            rows={3}
            className="w-full rounded-md border border-foreground/15 bg-background px-3 py-2 text-[13px] resize-none focus:outline-none focus:border-accent/50"
          />
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10.5px]">
            <span className="text-foreground/40">示例：</span>
            {(evalData?.queries?.slice(0, 6) || SAMPLE_QUERIES.map((s) => ({ id: s, text: s, tags: [], ideal_image_ids: [] }))).map((q) => {
              const sample: EvalQuery = (q as any).id ? (q as EvalQuery) : { id: '', text: String(q), tags: [], ideal_image_ids: [] }
              return (
                <button
                  key={sample.id || sample.text}
                  onClick={() => setText(sample.text)}
                  className="px-1.5 py-0.5 rounded border border-foreground/10 text-foreground/55 hover:bg-foreground/[0.04]"
                  title={sample.text}
                >
                  {sample.id ? `${sample.id} · ` : ''}{sample.text.slice(0, 14)}{sample.text.length > 14 ? '…' : ''}
                </button>
              )
            })}
          </div>
          {matchedEvalQuery && (
            <div className="mt-2 rounded-md border border-accent/30 bg-accent/[0.06] px-2.5 py-1.5 text-[11px] text-foreground/70 flex items-center gap-2">
              <Star size={11} className="text-accent" />
              <span>
                对应评估集 <strong className="text-accent">{matchedEvalQuery.id}</strong>
                {matchedEvalQuery.tags.length > 0 && (
                  <span className="text-foreground/45 ml-1">[{matchedEvalQuery.tags.join(' / ')}]</span>
                )}
                <span className="text-foreground/45 ml-2">
                  已标 {matchedEvalQuery.ideal_image_ids.length} 张理想答案
                </span>
              </span>
              <span className="ml-auto text-[10px] text-foreground/45">点击结果右上角 ⭐ 标注</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[11.5px] text-foreground/55 mb-1 block">策略预设</label>
            <div className="flex gap-1">
              {STRATEGY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setStrategy(opt.id)}
                  className={cn(
                    'flex-1 px-2 py-1.5 rounded border text-left transition-colors',
                    strategy === opt.id
                      ? 'border-accent bg-accent/10'
                      : 'border-foreground/10 hover:bg-foreground/[0.03]',
                  )}
                  title={opt.desc}
                >
                  <div className={cn('text-[11.5px] font-medium', strategy === opt.id ? 'text-accent' : 'text-foreground/75')}>
                    {opt.label}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11.5px] text-foreground/55 mb-1 block">多样性 (diversity)</label>
            <div className="flex gap-1">
              {(['strict', 'balanced', 'none'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDiversity(m)}
                  className={cn(
                    'flex-1 h-8 rounded border text-[11.5px]',
                    diversity === m
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-foreground/10 text-foreground/65 hover:bg-foreground/[0.03]',
                  )}
                >
                  {m === 'strict' ? '严格' : m === 'balanced' ? '平衡' : '不限'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11.5px] text-foreground/55 mb-1 block">返回数量 ({limit})</label>
            <Slider value={[limit]} onValueChange={([v]) => setLimit(v)} min={3} max={24} step={1} className="mt-2" />
          </div>
        </div>

        {/* Source filter — match only against AI generations / only originals / both */}
        <div className="flex items-center gap-2">
          <label className="text-[11.5px] text-foreground/55">候选来源</label>
          <div className="flex gap-1">
            {([
              { id: 'all', label: '全部' },
              { id: 'generated', label: '仅 AI 生成图' },
              { id: 'original', label: '仅原图' },
            ] as { id: SourceFilter; label: string }[]).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSourceFilter(opt.id)}
                className={cn(
                  'px-2 h-7 rounded border text-[11.5px]',
                  sourceFilter === opt.id
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-foreground/10 text-foreground/65 hover:bg-foreground/[0.03]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {sourceFilter !== 'all' && (
            <span className="text-[10.5px] text-foreground/40 ml-1">
              （传 <code className="px-1 bg-foreground/[0.04] rounded">filters.source_type={sourceFilter}</code> 给后端）
            </span>
          )}
        </div>

        {/* Project scope — primary auto-injected from current project; debug
            override available */}
        <div className="flex items-center gap-2 text-[11.5px]">
          <label className="text-foreground/55">主项目</label>
          <span className="inline-flex items-center gap-1.5 px-2 h-7 rounded border border-foreground/10 text-foreground/75">
            {projectColor(projectId) && (
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: projectColor(projectId) as string }}
              />
            )}
            {projectName(projectId)}
          </span>
          <label className="ml-2 inline-flex items-center gap-1.5 text-foreground/65 cursor-pointer">
            <input
              type="checkbox"
              checked={forceSingleProject}
              onChange={(e) => setForceSingleProject(e.target.checked)}
            />
            强制单项目（调试用，关闭跨项目召回）
          </label>
        </div>

        {/* Advanced */}
        <div className="border-t border-foreground/5 pt-2">
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            className="text-[11px] text-foreground/55 inline-flex items-center gap-1 hover:text-foreground/85"
          >
            {advanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            高级：自定义权重
          </button>
          {advanced && (
            <div className="mt-2 space-y-2 pl-3 border-l-2 border-foreground/8">
              <label className="flex items-center gap-2 text-[11.5px] text-foreground/65">
                <input
                  type="checkbox"
                  checked={useCustomWeights}
                  onChange={(e) => setUseCustomWeights(e.target.checked)}
                />
                覆盖策略预设权重
              </label>
              {useCustomWeights && (
                <div className="grid grid-cols-5 gap-3">
                  {(Object.keys(w) as Array<keyof typeof w>).map((k) => (
                    <div key={k}>
                      <label className="text-[10.5px] text-foreground/55 block">
                        {k} ({w[k].toFixed(2)})
                      </label>
                      <Slider
                        value={[w[k] * 100]}
                        onValueChange={([v]) => setW({ ...w, [k]: v / 100 })}
                        min={0}
                        max={100}
                        step={5}
                        className="mt-1"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-foreground/40">
            {result && (
              <>
                耗时 <strong className="text-foreground/65">{result.took_ms}ms</strong> · 候选{' '}
                <strong className="text-foreground/65">{result.debug.candidates}</strong> 张 · 返回{' '}
                <strong className="text-foreground/65">{result.matches.length}</strong> 张
              </>
            )}
          </div>
          <Button
            size="sm"
            onClick={onRun}
            disabled={matchMutation.isPending || !text.trim()}
            className="h-9 px-4"
          >
            {matchMutation.isPending && <Loader2 size={13} className="mr-1.5 animate-spin" />}
            <Target size={13} className="mr-1.5" />
            {matchMutation.isPending ? '匹配中…' : '开始匹配'}
          </Button>
        </div>
      </div>

      {/* Debug panel */}
      {result && (
        <div className="rounded-lg border border-foreground/8 p-4">
          <button
            type="button"
            onClick={() => setShowDebug(!showDebug)}
            className="text-[12px] text-foreground/65 inline-flex items-center gap-1 hover:text-foreground/85 mb-2"
          >
            {showDebug ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            诊断信息
          </button>
          {showDebug && (
            <div className="grid grid-cols-2 gap-3 text-[11.5px]">
              <DebugRow label="召回 (embedding)" value={`${result.debug.recall_emb} 张`} tone={result.debug.recall_emb > 0 ? 'success' : 'warning'} />
              <DebugRow label="召回 (keyword)" value={`${result.debug.recall_kw} 张`} tone={result.debug.recall_kw > 0 ? 'success' : 'warning'} />
              <DebugRow
                label="jieba 关键词"
                value={result.debug.kw_tokens.length > 0 ? result.debug.kw_tokens.join(' · ') : '—'}
              />
              <DebugRow
                label="LLM 扩展词"
                value={
                  (result.debug.expanded_keywords || []).length > 1
                    ? `${result.debug.expanded_keywords.length} 个`
                    : '未扩展（fallback to jieba）'
                }
                tone={(result.debug.expanded_keywords || []).length > 1 ? 'success' : 'warning'}
                detail={result.debug.expanded_keywords?.slice(0, 25).join(' · ')}
              />
              <DebugRow
                label="标签命中"
                value={
                  Object.keys(result.debug.tag_hits).length === 0
                    ? '—'
                    : Object.entries(result.debug.tag_hits)
                        .map(([d, vs]) => `${d}:${(vs as string[]).join('/')}`)
                        .join('  ·  ')
                }
              />
              <DebugRow
                label="生效权重"
                value={
                  result.debug.weights
                    ? Object.entries(result.debug.weights)
                        .map(([k, v]) => `${k}:${(v as number).toFixed(2)}`)
                        .join(' · ')
                    : '—'
                }
              />
            </div>
          )}
        </div>
      )}

      {/* Scope decision panel — auto-detected per-project quotas */}
      {result?.scope_decision && (
        <ScopeDecisionPanel
          decision={result.scope_decision}
          projectName={projectName}
          projectColor={projectColor}
        />
      )}

      {/* Results grid */}
      {result && result.matches.length > 0 && (
        <div className="space-y-3">
          <div className="text-[12px] font-medium text-foreground/75">
            匹配结果（按 score 降序）
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {result.matches.map((m) => (
              <ResultCard
                key={m.image_id}
                match={m}
                evalQueryId={matchedEvalQuery?.id || null}
                isIdeal={idealSet.has(m.image_id)}
                onToggleIdeal={(action) =>
                  idealMutation.mutate({ imageId: m.image_id, action })
                }
                togglePending={idealMutation.isPending}
                projectName={projectName}
                projectColor={projectColor}
              />
            ))}
          </div>
        </div>
      )}

      {result && result.matches.length === 0 && (
        <div className="rounded-lg border border-dashed border-foreground/15 py-8 text-center text-[13px] text-foreground/45">
          没有匹配的图片。<br />
          <span className="text-[11px] mt-1 inline-block">
            检查诊断信息：召回数为 0 时通常是「embedding 没对齐」或「文案完全没命中标签」。
          </span>
        </div>
      )}
    </div>
  )
}


// ── Sub components ─────────────────────────────────────────────────────────

function ScopeDecisionPanel({
  decision, projectName, projectColor,
}: {
  decision: ScopeDecision
  projectName: (id: string | null | undefined) => string
  projectColor: (id: string | null | undefined) => string | null
}) {
  // Show every project that produced a signal (even if quota=0 in the end),
  // so the operator can see WHY a project was excluded.
  const allPids = Array.from(new Set([
    ...Object.keys(decision.raw_signals || {}),
    ...Object.keys(decision.selected_quota || {}),
  ]))
  // Sort: primary first, then by signal desc.
  allPids.sort((a, b) => {
    if (a === decision.primary_project_id) return -1
    if (b === decision.primary_project_id) return 1
    return (decision.raw_signals[b] ?? 0) - (decision.raw_signals[a] ?? 0)
  })

  return (
    <div className="rounded-lg border border-foreground/8 p-3 bg-foreground/[0.015]">
      <div className="text-[12px] text-foreground/65 mb-2">
        匹配范围决策（自动）· 主项目：
        <strong className="text-foreground/85 ml-1">{projectName(decision.primary_project_id)}</strong>
      </div>
      <div className="space-y-1">
        {allPids.map((pid) => {
          const raw = decision.raw_signals[pid] ?? 0
          const weighted = decision.weighted_signals[pid] ?? 0
          const weight = decision.weights[pid] ?? 0
          const quota = decision.selected_quota[pid] ?? 0
          const isPrimary = pid === decision.primary_project_id
          const dropped = raw > 0 && quota === 0
          const color = projectColor(pid)
          return (
            <div
              key={pid}
              className={cn(
                'grid grid-cols-[160px_1fr_auto] items-center gap-3 px-2 py-1 rounded text-[11px]',
                isPrimary && 'bg-accent/[0.04]',
              )}
            >
              <div className="inline-flex items-center gap-1.5 truncate">
                {color && <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} />}
                <span className={cn('truncate', isPrimary ? 'text-accent font-medium' : 'text-foreground/75')}>
                  {projectName(pid)}
                </span>
                {isPrimary && <span className="text-[9px] text-accent/70">主</span>}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex-1 h-1 rounded-full bg-foreground/[0.06] overflow-hidden">
                  <div
                    className={cn('h-full', dropped ? 'bg-foreground/20' : 'bg-accent/60')}
                    style={{ width: `${Math.min(100, raw * 100)}%` }}
                  />
                </div>
                <span className="w-12 text-right tabular-nums text-foreground/45">
                  {raw.toFixed(3)}
                </span>
              </div>
              <div className="text-right tabular-nums whitespace-nowrap">
                {dropped ? (
                  <span className="text-foreground/30 text-[10px]">阈值未过 → 0 张</span>
                ) : (
                  <>
                    <span className="text-foreground/85 font-medium">{quota}</span>
                    <span className="text-foreground/40 text-[10px]"> 张 · {Math.round(weight * 100)}%</span>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-foreground/40 mt-2">
        信号 = 该项目 top-5 余弦均值。算法：减去 noise floor (0.30) → 主项目 ×1.3 → 跨项目双阈值过滤
        (绝对 ≥ 0.10 且相对 ≥ 主项目 40%) → softmax(T=0.3) → 主项目保底 75%。
      </p>
    </div>
  )
}


function DebugRow({
  label, value, tone = 'default', detail,
}: {
  label: string
  value: string
  tone?: 'default' | 'success' | 'warning'
  detail?: string
}) {
  return (
    <div>
      <div className="text-foreground/45 text-[10.5px] mb-0.5">{label}</div>
      <div
        className={cn(
          'text-[11.5px] truncate',
          tone === 'success' ? 'text-success'
          : tone === 'warning' ? 'text-warning'
          : 'text-foreground/85',
        )}
        title={detail || value}
      >
        {value}
      </div>
      {detail && detail !== value && (
        <div className="mt-0.5 text-[10px] text-foreground/45 line-clamp-2" title={detail}>
          {detail}
        </div>
      )}
    </div>
  )
}

function ResultCard({
  match, evalQueryId, isIdeal, onToggleIdeal, togglePending,
  projectName, projectColor,
}: {
  match: MatchedImage & { project_id?: string | null; is_primary_project?: boolean }
  evalQueryId: string | null
  isIdeal: boolean
  onToggleIdeal: (action: 'add' | 'remove') => void
  togglePending: boolean
  projectName: (id: string | null | undefined) => string
  projectColor: (id: string | null | undefined) => string | null
}) {
  const url = match.url.startsWith('http') ? match.url : `http://localhost:7879${match.url}`
  const thumb = match.thumbnail_url.startsWith('http')
    ? match.thumbnail_url
    : `http://localhost:7879${match.thumbnail_url}`
  // Score is shown over a dark `bg-black/60` plate, so use white-on-dark
  // variants — the theme `text-foreground/*` tokens are dark-on-light and
  // disappear here. Severity is encoded as hue, not by reusing semantic
  // tokens that were tuned for light backgrounds.
  const scoreColor =
    match.score >= 0.7 ? 'text-emerald-300'
    : match.score >= 0.4 ? 'text-amber-200'
    : 'text-white/65'

  // Make room for the ⭐ button only when it actually renders, otherwise
  // pin the score to the corner so we don't leave an empty dark slot.
  const scoreRightClass = evalQueryId ? 'right-9' : 'right-1'

  return (
    <div className={cn(
      'rounded-lg border overflow-hidden bg-card',
      isIdeal ? 'border-accent/60 ring-1 ring-accent/30' : 'border-foreground/8',
    )}>
      <div className="relative aspect-[4/3] bg-foreground/[0.04]">
        <img
          src={thumb}
          alt={match.file_name}
          loading="lazy"
          className="w-full h-full object-cover"
        />
        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-mono">
          #{match.rank}
        </div>
        <div className={cn('absolute top-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-mono', scoreRightClass, scoreColor)}>
          {match.score.toFixed(3)}
        </div>
        {evalQueryId && (
          <button
            type="button"
            onClick={() => onToggleIdeal(isIdeal ? 'remove' : 'add')}
            disabled={togglePending}
            title={isIdeal ? `从评估集 ${evalQueryId} 取消理想答案` : `标记为评估集 ${evalQueryId} 的理想答案`}
            className={cn(
              'absolute top-1 right-1 h-6 w-6 rounded flex items-center justify-center bg-black/60 hover:bg-black/80 transition',
              isIdeal ? 'text-accent' : 'text-white/80',
              togglePending && 'opacity-50 cursor-wait',
            )}
          >
            <Star size={12} fill={isIdeal ? 'currentColor' : 'none'} />
          </button>
        )}
        {match.cdn_synced && (
          <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-success/80 text-white text-[9px]">
            CDN
          </div>
        )}
      </div>
      <div className="p-2 space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-medium text-foreground/85 truncate flex-1" title={match.file_name}>
            {match.file_name}
          </span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(url)
              toast.success('已复制 URL')
            }}
            className="text-foreground/40 hover:text-foreground/75 shrink-0"
            title="复制 URL"
          >
            <CopyIcon size={11} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-foreground/45 flex-wrap">
          {match.width && match.height && (
            <span className="tabular-nums">{match.width}×{match.height}</span>
          )}
          <Badge variant="outline" className="text-[9px] px-1 py-0">
            {match.source_type === 'original' ? '原图' : '生成'}
          </Badge>
          {match.project_id && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-[9px] px-1 py-0 rounded border',
                match.is_primary_project
                  ? 'border-accent/30 text-accent/85'
                  : 'border-warning/30 text-warning/85',
              )}
              title={match.is_primary_project ? '主项目' : '相关推荐（跨项目命中）'}
            >
              {projectColor(match.project_id) && (
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: projectColor(match.project_id) as string }}
                />
              )}
              {projectName(match.project_id)}
              {!match.is_primary_project && <span className="ml-0.5">·相关</span>}
            </span>
          )}
        </div>
        {/* Score breakdown — compact bars */}
        <div className="space-y-0.5">
          {Object.entries(match.score_breakdown).slice(0, 3).map(([k, v]) => {
            const pct = Math.min(100, Math.max(0, (v as number) * 100))
            return (
              <div key={k} className="flex items-center gap-1.5 text-[9.5px]">
                <span className="w-12 text-foreground/45">{k}</span>
                <div className="flex-1 h-1 rounded-full bg-foreground/[0.06] overflow-hidden">
                  <div className="h-full bg-accent/60" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-8 text-right tabular-nums text-foreground/55">
                  {(v as number).toFixed(2)}
                </span>
              </div>
            )
          })}
        </div>
        {match.matched_tags.length > 0 && (
          <div className="flex flex-wrap gap-0.5 pt-0.5">
            {match.matched_tags.slice(0, 4).map((t, i) => (
              <Badge key={i} variant="secondary" className="text-[9px] px-1 py-0">
                {t.value}
              </Badge>
            ))}
          </div>
        )}
        {match.description && (
          <div className="text-[10px] text-foreground/55 line-clamp-2" title={match.description}>
            {match.description}
          </div>
        )}
      </div>
    </div>
  )
}
