import { useQuery } from '@tanstack/react-query'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Activity, AlertCircle, BarChart3, CheckCircle2, Clock, Copy, ExternalLink, RefreshCw, Target, TrendingDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { activeModuleAtom, matchLabNavRequestAtom } from '@/atoms/navigation'
import { matchPlaygroundSeedAtom } from '@/atoms/match'
import { matchAnalyticsWindowHoursAtom, matchLabActiveTabAtom } from '@/atoms/ui-state'

const API_BASE = 'http://localhost:7879'

interface Analytics {
  window_hours: number
  calls: { total: number; errors: number; error_rate: number }
  latency_ms: { avg: number; p50: number; p95: number }
  feedback: {
    total_events: number
    chosen_events: number
    unique_queries: number
    chosen_query_rate: number
    avg_chosen_rank: number | null
  }
  timeseries: { date: string; calls: number; errors: number; chosen: number }[]
  hard_queries: { text_hash: string; impressions: number; chosen: number; sample_text?: string | null }[]
}

const WINDOWS = [
  { hours: 24, label: '近 1 天' },
  { hours: 24 * 7, label: '近 7 天' },
  { hours: 24 * 30, label: '近 30 天' },
]

export function MatchAnalyticsTab() {
  const [windowHours, setWindowHours] = useAtom(matchAnalyticsWindowHoursAtom)
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setSeed = useSetAtom(matchPlaygroundSeedAtom)
  const setMatchLabNav = useSetAtom(matchLabNavRequestAtom)
  const setMatchLabTab = useSetAtom(matchLabActiveTabAtom)
  const replay = (text: string) => {
    setSeed({ text, autoRun: true })
    // We're already inside MatchLab — switch tabs directly. The nav atom
    // is set as a fallback so future entry points can deep-link in.
    setMatchLabTab('playground')
    setMatchLabNav({ tab: 'playground' })
    setActiveModule('match-lab')
  }

  const { data, refetch, isLoading } = useQuery<Analytics>({
    queryKey: ['match-analytics', windowHours],
    queryFn: () => fetch(`${API_BASE}/api/match/analytics?window_hours=${windowHours}`).then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const peakCalls = data?.timeseries.reduce((m, d) => Math.max(m, d.calls), 0) || 1

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              onClick={() => setWindowHours(w.hours)}
              className={cn(
                'px-3 h-7 rounded-md text-[12px] border transition-colors',
                windowHours === w.hours
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-foreground/10 text-foreground/60 hover:bg-foreground/[0.03]',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw size={11} className={cn('mr-1', isLoading && 'animate-spin')} /> 刷新
        </Button>
      </div>

      {!data ? (
        <div className="text-center py-12 text-[13px] text-foreground/40">加载中…</div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-4 gap-3">
            <KPI
              icon={<Activity size={13} />}
              label="匹配调用"
              value={data.calls.total.toLocaleString()}
              sub={data.calls.errors > 0 ? `${data.calls.errors} 错误 (${(data.calls.error_rate * 100).toFixed(1)}%)` : '无错误'}
              tone={data.calls.errors > 0 ? 'warning' : 'default'}
            />
            <KPI
              icon={<Clock size={13} />}
              label="延迟 P50 / P95"
              value={`${data.latency_ms.p50}ms`}
              sub={`P95 ${data.latency_ms.p95}ms · 平均 ${data.latency_ms.avg}ms`}
              tone={data.latency_ms.p95 > 3000 ? 'warning' : 'default'}
            />
            <KPI
              icon={<Target size={13} />}
              label="命中率（按 query 去重）"
              value={
                data.feedback.unique_queries > 0
                  ? `${Math.round(data.feedback.chosen_query_rate * 100)}%`
                  : '—'
              }
              sub={`${data.feedback.unique_queries} 个独立 query · ${data.feedback.total_events} 次反馈`}
              tone={
                data.feedback.unique_queries === 0
                  ? 'muted'
                  : data.feedback.chosen_query_rate >= 0.7 ? 'success'
                  : data.feedback.chosen_query_rate >= 0.5 ? 'default'
                  : 'warning'
              }
            />
            <KPI
              icon={<CheckCircle2 size={13} />}
              label="平均选中排名"
              value={data.feedback.avg_chosen_rank != null ? `#${data.feedback.avg_chosen_rank.toFixed(1)}` : '—'}
              sub="数值越低排得越准"
              tone={
                data.feedback.avg_chosen_rank == null ? 'muted'
                : data.feedback.avg_chosen_rank <= 3 ? 'success'
                : data.feedback.avg_chosen_rank <= 6 ? 'default'
                : 'warning'
              }
            />
          </div>

          {/* Time series */}
          <div className="rounded-lg border border-foreground/8 p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 size={13} className="text-foreground/55" />
              <h3 className="text-[12.5px] font-medium text-foreground/80">每日调用量 + 选中数</h3>
              <span className="ml-auto text-[10.5px] text-foreground/40">
                灰=调用 · 绿=被选中 · 红=错误
              </span>
            </div>
            {data.timeseries.length === 0 || data.timeseries.every((d) => d.calls === 0) ? (
              <div className="text-center py-6 text-[12px] text-foreground/40">
                窗口内无调用记录
              </div>
            ) : (
              <div className="flex items-end gap-1 h-24">
                {data.timeseries.map((d) => {
                  const callPct = (d.calls / peakCalls) * 100
                  const chosenPct = d.calls > 0 ? (d.chosen / d.calls) * callPct : 0
                  const errPct = d.calls > 0 ? (d.errors / d.calls) * callPct : 0
                  return (
                    <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group" title={`${d.date}: ${d.calls} 次 · ${d.chosen} 选中 · ${d.errors} 错误`}>
                      <div className="relative w-full flex-1 rounded-sm bg-foreground/[0.04] overflow-hidden">
                        <div className="absolute bottom-0 left-0 right-0 bg-foreground/30" style={{ height: `${callPct}%` }} />
                        <div className="absolute bottom-0 left-0 right-0 bg-success/70" style={{ height: `${chosenPct}%` }} />
                        {errPct > 0 && (
                          <div className="absolute bottom-0 left-0 right-1/2 bg-destructive/70" style={{ height: `${errPct}%` }} />
                        )}
                      </div>
                      <span className="text-[9px] text-foreground/40 whitespace-nowrap">
                        {d.date.slice(5)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Hard queries */}
          <div className="rounded-lg border border-foreground/8 p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingDown size={13} className="text-warning" />
              <h3 className="text-[12.5px] font-medium text-foreground/80">未命中 top-20</h3>
              <span className="text-[10.5px] text-foreground/40">
                被搜过 ≥2 次但用户从未选中任何返回图 — 提示需要补图
              </span>
            </div>
            {data.hard_queries.length === 0 ? (
              <div className="text-center py-6 text-[12px] text-foreground/40 flex items-center justify-center gap-2">
                <CheckCircle2 size={13} className="text-success" />
                没有"难 query"，所有 query 至少被命中过一次
              </div>
            ) : (
              <div className="text-[11.5px]">
                <div className="grid grid-cols-[1fr_80px_60px_80px] gap-2 px-2 py-1 text-[10.5px] text-foreground/40 border-b border-foreground/5">
                  <span>query 原文（窗口内反查；找不到时显示哈希）</span>
                  <span className="text-right">被搜次数</span>
                  <span className="text-right">已选中</span>
                  <span className="text-right">操作</span>
                </div>
                {data.hard_queries.map((q) => (
                  <div key={q.text_hash} className="grid grid-cols-[1fr_80px_60px_80px] gap-2 px-2 py-1.5 hover:bg-foreground/[0.02] items-center">
                    {q.sample_text ? (
                      <div className="text-[11px] text-foreground/80 truncate flex items-center gap-1.5" title={q.sample_text}>
                        <span className="truncate">{q.sample_text}</span>
                        <button
                          className="text-foreground/35 hover:text-foreground/70 shrink-0"
                          title="复制原文"
                          onClick={() => {
                            navigator.clipboard.writeText(q.sample_text!)
                            toast.success('已复制查询原文')
                          }}
                        >
                          <Copy size={10} />
                        </button>
                      </div>
                    ) : (
                      <code className="font-mono text-[10.5px] text-foreground/45" title={`hash ${q.text_hash}（窗口内未找到对应请求体）`}>
                        {q.text_hash}
                      </code>
                    )}
                    <span className="text-right tabular-nums text-warning">{q.impressions}</span>
                    <span className="text-right tabular-nums text-foreground/40">{q.chosen}</span>
                    <div className="text-right">
                      {q.sample_text ? (
                        <button
                          onClick={() => replay(q.sample_text!)}
                          className="text-[10px] text-accent hover:underline inline-flex items-center gap-0.5"
                          title="跳到资产库 → 试匹配复跑这条 query"
                        >
                          复跑 <ExternalLink size={9} />
                        </button>
                      ) : (
                        <span className="text-[10px] text-foreground/30">—</span>
                      )}
                    </div>
                  </div>
                ))}
                <p className="text-[10.5px] text-foreground/40 mt-2 leading-relaxed">
                  💡 原文从窗口内的 api_request_logs.request_body 反查得到（仅匿名 hash 落库；原文不会跨窗口保留）。点「复跑」直接跳转到试匹配并预填。
                </p>
              </div>
            )}
          </div>

          {data.feedback.total_events === 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-[11.5px] text-warning flex items-start gap-2">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <div>
                <strong>反馈数据为空</strong> — UGC 应用需要在用户选中图片时调用
                <code className="px-1 mx-1 bg-warning/10 rounded">POST /open-api/v1/images/{'{id}'}/track-usage</code>
                才能看到命中率。详见 <code>docs/UGC-INTEGRATION-GUIDE.md</code> 第 5 节。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}


function KPI({
  icon, label, value, sub, tone = 'default',
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'success' | 'warning' | 'muted'
}) {
  const valueColor =
    tone === 'success' ? 'text-success'
    : tone === 'warning' ? 'text-warning'
    : tone === 'muted' ? 'text-foreground/45'
    : 'text-foreground/85'
  return (
    <div className="rounded-md border border-foreground/8 bg-foreground/[0.015] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-foreground/50 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn('text-[18px] font-semibold tabular-nums', valueColor)}>{value}</div>
      {sub && <div className="text-[10.5px] text-foreground/40 mt-0.5 truncate" title={sub}>{sub}</div>}
    </div>
  )
}
