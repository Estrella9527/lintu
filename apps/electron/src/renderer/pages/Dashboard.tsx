import { useAtomValue, useSetAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { activeModuleAtom } from '@/atoms/navigation'
import { EmptyState } from '@/components/shared/EmptyState'
import { Skeleton } from '@/components/shared/Skeleton'
import { MatchAnalyticsPanel } from '@/components/dashboard/MatchAnalyticsPanel'
import {
  Image,
  CheckCircle,
  Tags,
  XCircle,
  Loader2,
  ListChecks,
  FolderOpen,
} from 'lucide-react'
import type { DashboardStats, TaskRecord } from '@/lib/types'

export default function Dashboard() {
  const projectId = useAtomValue(activeProjectIdAtom) || ''
  const setActiveModule = useSetAtom(activeModuleAtom)

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => api.stats.dashboard(projectId),
    refetchInterval: 5000,
    enabled: !!projectId,
  })

  if (!projectId) {
    return (
      <div className="p-6">
        <h1 className="text-[15px] font-semibold text-foreground mb-6">仪表盘</h1>
        <EmptyState
          icon={FolderOpen}
          title="还没有项目"
          description="去流水线选择一个图片目录，自动创建第一个项目并开始扫图"
          action={{ label: '去流水线', onClick: () => setActiveModule('pipeline') }}
        />
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="p-6">
        <h1 className="text-[15px] font-semibold text-foreground mb-6">仪表盘</h1>
        <div className="grid grid-cols-5 gap-4 mb-6">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton.StatCard key={i} />)}
        </div>
      </div>
    )
  }

  const stats: DashboardStats = data

  return (
    <div className="p-6 space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard icon={Image} label="图片总量" value={stats.counts.total} color="text-accent" />
        <StatCard
          icon={CheckCircle}
          label="质检通过"
          value={stats.counts.passed}
          color="text-success"
          sub={stats.rates.quality_pass > 0 ? `${(stats.rates.quality_pass * 100).toFixed(1)}%` : undefined}
        />
        <StatCard
          icon={Tags}
          label="已打标"
          value={stats.counts.tagged}
          color="text-info"
          sub={stats.rates.tag_progress > 0 ? `${(stats.rates.tag_progress * 100).toFixed(1)}%` : undefined}
        />
        <StatCard icon={XCircle} label="被淘汰" value={stats.counts.rejected} color="text-destructive" />
        <StatCard icon={Loader2} label="运行中任务" value={stats.running_tasks.length} color="text-foreground/60" />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Recent tasks */}
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">近期任务</h3>
          {stats.recent_tasks.length === 0 ? (
            <EmptyState
              compact
              icon={ListChecks}
              title="还没有任务"
              description="跑一次流水线后这里会显示任务记录"
              action={{ label: '去流水线', variant: 'outline', onClick: () => setActiveModule('pipeline') }}
            />
          ) : (
            <div className="space-y-2">
              {stats.recent_tasks.map((t: TaskRecord) => (
                <div key={t.id} className="flex items-center justify-between py-1.5 text-[12px]">
                  <div className="flex items-center gap-2">
                    <StatusDot status={t.status} />
                    <span className="text-foreground/70">{taskTypeLabel(t.type)}</span>
                  </div>
                  <div className="flex items-center gap-3 text-foreground/40">
                    <span>{t.processed}/{t.total}</span>
                    <span>{t.created_at ? new Date(t.created_at).toLocaleDateString('zh-CN') : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tag distribution */}
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">标签分布 · Top 20</h3>
          {stats.tag_distribution.length === 0 ? (
            <EmptyState
              compact
              icon={Tags}
              title="还没有标签"
              description="跑流水线的「标注」阶段后，这里会显示标签分布"
            />
          ) : (
            <div className="space-y-1.5">
              {stats.tag_distribution.map((d) => {
                const max = stats.tag_distribution[0]?.count || 1
                return (
                  <div key={`${d.dimension}-${d.value}`} className="flex items-center gap-2">
                    <div className="w-24 text-[11px] text-foreground/40 truncate">
                      {d.dimension}:{d.value}
                    </div>
                    <div className="flex-1 h-1.5 bg-foreground/[0.04] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full"
                        style={{ width: `${(d.count / max) * 100}%` }}
                      />
                    </div>
                    <div className="w-8 text-right text-[11px] text-foreground/40 tabular-nums">
                      {d.count}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <MatchAnalyticsPanel />
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color, sub }: {
  icon: React.ElementType; label: string; value: number; color: string; sub?: string
}) {
  return (
    <div className="rounded-lg border border-foreground/5 p-4 space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon size={14} className={color} strokeWidth={1.5} />
        <span className="text-[12px] text-foreground/50">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <p className="text-[22px] font-semibold text-foreground/80 tabular-nums">
          {value.toLocaleString()}
        </p>
        {sub && <span className="text-[11px] text-foreground/40">{sub}</span>}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running' ? 'bg-success' :
    status === 'completed' ? 'bg-accent' :
    status === 'failed' ? 'bg-destructive' :
    status === 'queued' ? 'bg-info' : 'bg-foreground/20'
  return <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
}

function taskTypeLabel(type: string) {
  const map: Record<string, string> = {
    scan: '图片扫描',
    quality_check: '质量检查',
    dedup: '去重',
    tag: 'AI打标',
  }
  return map[type] || type
}
