import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { SeedSelector } from './SeedSelector'
import { ParameterForm, type FieldConfig } from './ParameterForm'
import { Button } from '@/components/ui/button'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { ImageRecord } from '@/lib/types'

interface StrategyPageProps {
  taskType: string
  fields: FieldConfig[]
  maxSeedImages?: number
}

export function StrategyPage({ taskType, fields, maxSeedImages }: StrategyPageProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  const [seeds, setSeeds] = useState<ImageRecord[]>([])
  const [params, setParams] = useState<Record<string, any>>(() => {
    const defaults: Record<string, any> = {}
    fields.forEach((f) => { if (f.default !== undefined) defaults[f.name] = f.default })
    return defaults
  })
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const progress = useTaskProgress(activeTaskId)

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择项目')
      if (seeds.length === 0) throw new Error('请先选择种子图')
      const result = await api.tasks.create(taskType, {
        project_id: projectId,
        image_ids: seeds.map((s) => s.id),
        ...params,
      } as any)
      return result
    },
    onSuccess: (data) => {
      setActiveTaskId(data.task_id)
      toast.success('任务已启动')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* Left: 3-step config */}
      <div className="col-span-2 space-y-4">
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">1. 选择种子图</h3>
          <SeedSelector selectedImages={seeds} onSelect={setSeeds} maxSelect={maxSeedImages} />
        </section>

        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">2. 参数配置</h3>
          <ParameterForm fields={fields} values={params} onChange={setParams} />
        </section>

        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">3. 生产</h3>
          <Button
            className="w-full"
            disabled={seeds.length === 0 || !projectId || startMutation.isPending || !!activeTaskId}
            onClick={() => startMutation.mutate()}
          >
            {startMutation.isPending ? '提交中...' : activeTaskId ? '任务运行中' : `开始生产 (${seeds.length} 张)`}
          </Button>
        </section>
      </div>

      {/* Right: summary + progress */}
      <div className="col-span-1 space-y-4">
        <section className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">任务摘要</h3>
          <div className="space-y-2 text-[13px] text-foreground/40">
            <div className="flex justify-between"><span>种子图</span><span>{seeds.length} 张</span></div>
            <div className="flex justify-between"><span>策略</span><span>{taskType}</span></div>
            {Object.entries(params).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span>{fields.find((f) => f.name === k)?.label || k}</span>
                <span className="text-foreground/60">{String(v)}</span>
              </div>
            ))}
          </div>
        </section>

        {activeTaskId && (
          <TaskProgressCard
            task={{ id: activeTaskId, status: progress?.status || 'running', total: progress?.total || seeds.length, processed: progress?.processed || 0, failed: 0, cost_usd: 0 } as any}
            progress={progress}
            onCancel={() => { api.tasks.cancel(activeTaskId); setActiveTaskId(null) }}
          />
        )}
      </div>
    </div>
  )
}
