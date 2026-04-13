import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { ConfigCard } from '@/components/pipeline/ConfigCard'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { TaskRecord } from '@/lib/types'

export function TaggingTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [concurrency, setConcurrency] = useState(5)
  const [costLimit, setCostLimit] = useState('10')

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'tag'],
    queryFn: () => api.tasks.list({ type: 'tag' }),
    refetchInterval: 3000,
  })

  const activeTask = tasks?.find(
    (t: TaskRecord) => t.status === 'running' || t.status === 'queued',
  )
  const lastTask = tasks?.[0]
  const progress = useTaskProgress(activeTask?.id ?? null)

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
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      <ConfigCard>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">
              并发数: {concurrency}
            </label>
            <Slider
              value={[concurrency]}
              onValueChange={([v]) => setConcurrency(v)}
              min={1}
              max={10}
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

        <div className="text-[11px] text-foreground/30 bg-foreground/[0.02] rounded-md p-2">
          使用 Gemini 2.5 Flash 进行 7 维度自动打标。需在设置→AI服务商中配置 API Key。
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || !!activeTask}
          className="w-full"
        >
          {activeTask ? '打标任务运行中' : '开始打标'}
        </Button>
      </ConfigCard>

      {(activeTask || (lastTask && lastTask.status === 'completed')) && (
        <TaskProgressCard
          task={activeTask || lastTask!}
          progress={progress}
          onPause={activeTask ? () => api.tasks.pause(activeTask.id) : undefined}
          onCancel={activeTask ? () => api.tasks.cancel(activeTask.id) : undefined}
          extraStats={
            <div className="flex gap-4 text-[12px]">
              {progress?.cost_usd !== undefined && (
                <span className="text-info">费用: ${progress.cost_usd.toFixed(4)}</span>
              )}
            </div>
          }
        />
      )}

      {lastTask?.status === 'completed' && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">打标结果</h3>
          <div className="text-[12px] text-foreground/40">
            任务完成，可在资产库中按标签维度浏览图片
          </div>
        </div>
      )}
    </div>
  )
}
