import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, MousePointerClick, Timer } from 'lucide-react'

import { api } from '@/lib/api'
import { EmptyState } from '@/components/shared/EmptyState'
import { Skeleton } from '@/components/shared/Skeleton'
import { cn } from '@/lib/utils'

/**
 * 仪表盘的「匹配反馈看板」区段。消费 /api/match/analytics 一个端点把
 * 全部指标渲染出来：调用量 / 命中率 / 延迟 / 时间序列 / Top 失败查询。
 *
 * 数据源：`apps/sidecar/sidecar/routers/match_analytics.py:match_analytics`
 */

const WINDOW_OPTIONS: { id: '24h' | '7d' | '30d'; label: string; hours: number }[] = [
  { id: '24h', label: '24h',  hours: 24 },
  { id: '7d',  label: '7天',  hours: 24 * 7 },
  { id: '30d', label: '30天', hours: 24 * 30 },
]

export function MatchAnalyticsPanel() {
  const [windowId, setWindowId] = useState<'24h' | '7d' | '30d'>('7d')
  const windowHours = WINDOW_OPTIONS.find((w) => w.id === windowId)!.hours

  const { data, isLoading, isError } = useQuery({
    queryKey: ['match-analytics', windowHours],
    queryFn: () => api.matchAnalytics.overview(windowHours),
    refetchInterval: 5 * 60 * 1000,
  })

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground/85">匹配反馈看板</h2>
          <p className="text-[11px] text-foreground/45 mt-0.5">UGC 端调用量 / 命中率 / 性能 / 失败查询</p>
        </div>
        <WindowSwitcher value={windowId} onChange={setWindowId} />
      </div>

      {isLoading && (
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton.StatCard key={i} />)}
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] p-3 text-[12px] text-destructive">
          加载失败：检查 sidecar 是否在 7879 端口
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-4 gap-3">
            <Kpi
              icon={Activity}
              label="调用量"
              value={data.calls.total.toLocaleString()}
              sub={data.calls.errors > 0 ? `${data.calls.errors} 个错误` : '0 错误'}
              tone={data.calls.errors > 0 ? 'warning' : 'normal'}
            />
            <Kpi
              icon={MousePointerClick}
              label="命中率"
              value={`${(data.feedback.chosen_query_rate * 100).toFixed(1)}%`}
              sub={`${data.feedback.unique_queries} 个不同查询`}
              tone={data.feedback.chosen_query_rate >= 0.5 ? 'good' : 'warning'}
            />
            <Kpi
              icon={Timer}
              label="P95 延迟"
              value={`${data.latency_ms.p95}ms`}
              sub={`平均 ${data.latency_ms.avg}ms`}
              tone={data.latency_ms.p95 > 1500 ? 'warning' : 'normal'}
            />
            <Kpi
              icon={MousePointerClick}
              label="平均点击位"
              value={data.feedback.avg_chosen_rank !== null
                ? `第 ${data.feedback.avg_chosen_rank.toFixed(1)} 张`
                : '—'}
              sub={`${data.feedback.chosen_events} 次点击`}
              tone={
                data.feedback.avg_chosen_rank === null
                  ? 'normal'
                  : data.feedback.avg_chosen_rank <= 3 ? 'good' : 'normal'
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <CallsTimeseries data={data.timeseries} />
            <HardQueries data={data.hard_queries} />
          </div>
        </>
      )}
    </section>
  )
}

function WindowSwitcher({
  value, onChange,
}: { value: '24h' | '7d' | '30d'; onChange: (v: '24h' | '7d' | '30d') => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-foreground/[0.04] p-0.5">
      {WINDOW_OPTIONS.map((w) => (
        <button
          key={w.id}
          onClick={() => onChange(w.id)}
          className={cn(
            'px-2.5 py-1 text-[11px] rounded transition-colors',
            value === w.id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-foreground/55 hover:text-foreground/85',
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  )
}

type Tone = 'normal' | 'good' | 'warning'

const TONE_COLOR: Record<Tone, string> = {
  normal:  'text-foreground/85',
  good:    'text-emerald-600',
  warning: 'text-amber-600',
}

function Kpi({
  icon: Icon, label, value, sub, tone = 'normal',
}: {
  icon: typeof Activity
  label: string
  value: string | number
  sub?: string
  tone?: Tone
}) {
  return (
    <div className="rounded-lg border border-foreground/5 p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-foreground/50">{label}</span>
        <Icon size={12} className="text-foreground/35" />
      </div>
      <div className={cn('text-[20px] font-semibold tabular-nums', TONE_COLOR[tone])}>
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-foreground/45">{sub}</div>}
    </div>
  )
}

function CallsTimeseries({
  data,
}: { data: Array<{ date: string; calls: number; errors: number; chosen: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.calls))
  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <h3 className="text-[12px] font-medium text-foreground/65 mb-3">每日调用 + 点击</h3>
      {data.length === 0 ? (
        <EmptyState compact icon={Activity} title="窗口内无数据" description="UGC 还没调过匹配 API" />
      ) : (
        <div className="space-y-1.5">
          {data.map((d) => {
            const heightPct = (d.calls / max) * 100
            const chosenPct = d.calls > 0 ? (d.chosen / d.calls) * 100 : 0
            return (
              <div key={d.date} className="flex items-center gap-2 text-[10.5px]">
                <span className="w-16 text-foreground/40 tabular-nums">{d.date.slice(5)}</span>
                <div className="flex-1 h-3 rounded-sm bg-foreground/[0.04] relative overflow-hidden">
                  <div
                    className="absolute left-0 top-0 h-full bg-accent/40"
                    style={{ width: `${heightPct}%` }}
                  />
                  <div
                    className="absolute left-0 top-0 h-full bg-emerald-500/60"
                    style={{ width: `${heightPct * (chosenPct / 100)}%` }}
                  />
                </div>
                <span className="w-12 text-right text-foreground/55 tabular-nums">
                  {d.calls}
                </span>
                <span className="w-10 text-right text-emerald-600 tabular-nums" title="点击数">
                  {d.chosen}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function HardQueries({
  data,
}: {
  data: Array<{ text_hash: string; impressions: number; chosen: number; sample_text?: string | null }>
}) {
  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[12px] font-medium text-foreground/65">无人点击的查询 Top 20</h3>
        {data.length > 0 && (
          <span className="text-[10.5px] text-amber-600 inline-flex items-center gap-1">
            <AlertTriangle size={10} /> 候选同义词来源
          </span>
        )}
      </div>
      {data.length === 0 ? (
        <EmptyState
          compact
          icon={MousePointerClick}
          title="所有查询都至少有 1 次点击"
          description="表示当前匹配命中率良好"
        />
      ) : (
        <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
          {data.map((q) => (
            <div
              key={q.text_hash}
              className="flex items-center gap-2 text-[11.5px] py-1 px-2 rounded hover:bg-foreground/[0.03]"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-foreground/85" title={q.sample_text ?? q.text_hash}>
                  {q.sample_text || <span className="font-mono text-foreground/45">{q.text_hash}</span>}
                </div>
              </div>
              <span className="text-[10.5px] text-foreground/45 shrink-0 tabular-nums">
                {q.impressions} 次展示
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
