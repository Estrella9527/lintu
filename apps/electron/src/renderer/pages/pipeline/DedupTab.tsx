import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { ConfigCard } from '@/components/pipeline/ConfigCard'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { TaskRecord } from '@/lib/types'

export function DedupTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [threshold, setThreshold] = useState(10)

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'dedup'],
    queryFn: () => api.tasks.list({ type: 'dedup' }),
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
      return api.tasks.create('dedup', {
        project_id: projectId,
        threshold,
        strategy: 'highest_quality',
      } as any)
    },
    onSuccess: () => {
      toast.success('去重任务已启动')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      <ConfigCard>
        <div className="space-y-2">
          <label className="text-[12px] text-foreground/50">
            pHash 汉明距离阈值 (越小越严格): {threshold}
          </label>
          <Slider
            value={[threshold]}
            onValueChange={([v]) => setThreshold(v)}
            min={1}
            max={20}
            step={1}
          />
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || !!activeTask}
          className="w-full"
        >
          {activeTask ? '去重任务运行中' : '开始去重'}
        </Button>
      </ConfigCard>

      {(activeTask || (lastTask && lastTask.status === 'completed')) && (
        <TaskProgressCard
          task={activeTask || lastTask!}
          progress={progress}
          onPause={activeTask ? () => api.tasks.pause(activeTask.id) : undefined}
          onCancel={activeTask ? () => api.tasks.cancel(activeTask.id) : undefined}
          extraStats={
            progress?.phase ? (
              <div className="text-[12px] text-foreground/40">
                阶段: {progress.phase === 'hashing' ? '计算哈希' : '分组比对'}
              </div>
            ) : null
          }
        />
      )}

      {lastTask?.status === 'completed' && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">去重结果</h3>
          <div className="text-[12px] text-foreground/40">
            任务完成，可在资产库中查看保留/淘汰的图片
          </div>
        </div>
      )}
    </div>
  )
}
