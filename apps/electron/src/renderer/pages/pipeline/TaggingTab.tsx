import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeModuleAtom } from '@/atoms/navigation'
import { ArrowRight } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { Button } from '@/components/ui/button'
import { InfoHint } from '@/components/shared/InfoHint'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { ConfigCard } from '@/components/pipeline/ConfigCard'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import { Tags } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TaskRecord } from '@/lib/types'

export function TaggingTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const setActiveModule = useSetAtom(activeModuleAtom)
  const [concurrency, setConcurrency] = useState(24)
  const [costLimit, setCostLimit] = useState('10')

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'tag', projectId],
    queryFn: () => api.tasks.list({ type: 'tag', project_id: projectId! }),
    refetchInterval: 3000,
    enabled: !!projectId,
  })

  const blockingTask = tasks?.find(
    (t: TaskRecord) => t.status === 'running' || t.status === 'queued' || t.status === 'paused',
  )
  const lastTask = tasks?.[0]
  const visibleTask = blockingTask ?? lastTask
  const progress = useTaskProgress(
    blockingTask?.status === 'running' || blockingTask?.status === 'queued'
      ? blockingTask.id
      : null,
  )

  const refreshTasks = () => queryClient.invalidateQueries({ queryKey: ['tasks'] })

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择或创建项目')
      return api.tasks.create('tag', {
        project_id: projectId,
        concurrency,
        cost_limit: parseFloat(costLimit) || 10,
      } as any)
    },
    onSuccess: () => {
      toast.success('打标任务已启动')
      refreshTasks()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      {/* What is this for? — distinguishes from 向量化 */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3">
        <div className="flex items-start gap-2">
          <Tags size={14} className="text-foreground/55 shrink-0 mt-0.5" />
          <div className="text-[12px] text-foreground/65 leading-relaxed">
            <strong className="text-foreground/85">打标</strong>：让 AI 视觉模型为每张图<strong>分类 + 写描述</strong>。
            产出 <strong>12 个维度的结构化标签</strong>（场景、季节、风格、情绪、构图…）+ 50-80 字长描述。
            <span className="text-foreground/45 ml-1">
              用途：资产库筛选、文图匹配的 keyword 召回、覆盖矩阵分析。
            </span>
            <div className="text-[11px] text-foreground/45 mt-1">
              ↔ 与<strong>向量化</strong>的区别：向量化产出机器用的数学向量（用于跨模态语义召回），
              打标产出人能读的结构化文本。两者互补，建议都跑。
            </div>
          </div>
        </div>
      </div>

      <ConfigCard>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50 flex items-center gap-2">
              <span className="inline-flex items-center gap-1">
                并发数: <span className={cn('tabular-nums font-medium',
                  concurrency >= 48 ? 'text-warning' : concurrency >= 24 ? 'text-info' : 'text-foreground/85'
                )}>{concurrency}</span>
                <InfoHint text={
                  '中转 (one-API/new-api) 24-48 并发都安全；\n' +
                  'OpenAI / Gemini 官方 API 限流较严，推荐 ≤ 8。'
                } />
              </span>
              {concurrency >= 48 && (
                <span className="text-[10px] text-warning ml-auto">⚠ 注意监控 provider 配额</span>
              )}
            </label>
            <Slider
              value={[concurrency]}
              onValueChange={([v]) => setConcurrency(v)}
              min={1}
              max={64}
              step={1}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">费用上限 (USD)</label>
            <Input
              type="number"
              value={costLimit}
              onChange={(e) => setCostLimit(e.target.value)}
              min={0.1}
              step={0.5}
              className="h-8 text-[13px]"
            />
          </div>
        </div>

        <div className="text-[11px] text-foreground/45 bg-foreground/[0.02] rounded-md p-2">
          使用<strong className="text-foreground/65">「设置 → AI 服务商」</strong>中配置的<strong className="text-foreground/65">通用模型（视觉/打标）</strong>，
          按当前的标签维度自动分类。需先确认已配好可用的视觉模型。
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || !!blockingTask}
          className="w-full"
        >
          {blockingTask?.status === 'paused'
            ? '打标任务已暂停'
            : blockingTask
              ? '打标任务运行中'
              : '开始打标'}
        </Button>
      </ConfigCard>

      {visibleTask && (
        <TaskProgressCard
          task={visibleTask}
          progress={progress}
          onPause={visibleTask.status === 'running' ? async () => {
            await api.tasks.pause(visibleTask.id)
            refreshTasks()
          } : undefined}
          onResume={visibleTask.status === 'paused' ? async () => {
            await api.tasks.resume(visibleTask.id)
            refreshTasks()
          } : undefined}
          onCancel={['running', 'queued', 'paused'].includes(visibleTask.status) ? async () => {
            await api.tasks.cancel(visibleTask.id)
            refreshTasks()
          } : undefined}
          onRetry={['failed', 'cancelled'].includes(visibleTask.status) ? async () => {
            const result = await api.tasks.retry(visibleTask.id) as { ok?: boolean; message?: string }
            if (result.ok) {
              toast.success('打标任务已重新入队')
              refreshTasks()
            } else {
              toast.error(result.message || '重试失败')
            }
          } : undefined}
          extraStats={
            <div className="space-y-2 text-[12px]">
              {(progress?.cost_usd !== undefined || visibleTask.cost_usd > 0) && (
                <span className="text-info">
                  费用: ${(progress?.cost_usd ?? visibleTask.cost_usd).toFixed(4)}
                </span>
              )}
              {visibleTask.status === 'failed' && visibleTask.error_message && (
                <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-destructive whitespace-pre-wrap">
                  {visibleTask.error_message}
                </div>
              )}
            </div>
          }
        />
      )}

      {visibleTask?.status === 'completed' && visibleTask.processed > 0 && visibleTask.failed === 0 && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">打标结果</h3>
          <p className="text-[12px] text-foreground/55 mb-3">
            打标完成。下一步：去资产库用「🏷️ 标签」筛选器按维度浏览，或用「🪄 试匹配」测试效果。
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline" size="sm" className="h-8 text-[12px]"
              onClick={() => setActiveModule('asset-library')}
            >
              去资产库筛标签
              <ArrowRight size={11} className="ml-1 text-foreground/40" />
            </Button>
            <Button
              variant="outline" size="sm" className="h-8 text-[12px]"
              onClick={() => setActiveModule('settings')}
            >
              查看打标质量审计
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
