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
import { DirectorySelector } from '@/components/pipeline/DirectorySelector'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { TaskRecord } from '@/lib/types'

export function QualityCheckTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)

  const [directory, setDirectory] = useState<string | null>(null)
  const [minResolution, setMinResolution] = useState(720)
  const [blurThreshold, setBlurThreshold] = useState(80)
  const [brightnessMin, setBrightnessMin] = useState(30)
  const [brightnessMax, setBrightnessMax] = useState(225)

  // Find running/recent quality_check task
  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'quality_check'],
    queryFn: () => api.tasks.list({ type: 'quality_check' }),
    refetchInterval: 3000,
  })

  const activeTask = tasks?.find(
    (t: TaskRecord) => t.status === 'running' || t.status === 'queued',
  )
  const lastTask = tasks?.[0]

  const progress = useTaskProgress(activeTask?.id ?? null)

  // Scan + quality check flow
  const startMutation = useMutation({
    mutationFn: async () => {
      if (!directory) throw new Error('请先选择图片目录')
      if (!projectId) throw new Error('请先选择或创建项目')

      // 1. Scan images first
      await api.tasks.create('scan', {
        project_id: projectId,
        directory,
      } as any)
      await new Promise((r) => setTimeout(r, 2000))

      // 2. Create quality check task
      const result = await api.tasks.create('quality_check', {
        project_id: projectId,
        min_resolution: minResolution,
        blur_threshold: blurThreshold,
        brightness_min: brightnessMin,
        brightness_max: brightnessMax,
      } as any)

      return result
    },
    onSuccess: () => {
      toast.success('质检任务已启动')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      {/* Config */}
      <ConfigCard>
        <DirectorySelector value={directory} onChange={setDirectory} label="原图目录" />

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">
              最小分辨率 (短边): {minResolution}px
            </label>
            <Slider
              value={[minResolution]}
              onValueChange={([v]) => setMinResolution(v)}
              min={360}
              max={2000}
              step={10}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">
              模糊阈值 (越高越严格): {blurThreshold}
            </label>
            <Slider
              value={[blurThreshold]}
              onValueChange={([v]) => setBlurThreshold(v)}
              min={10}
              max={300}
              step={5}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">
              最低亮度: {brightnessMin}
            </label>
            <Slider
              value={[brightnessMin]}
              onValueChange={([v]) => setBrightnessMin(v)}
              min={0}
              max={100}
              step={5}
            />
          </div>
          <div className="space-y-2">
            <label className="text-[12px] text-foreground/50">
              最高亮度: {brightnessMax}
            </label>
            <Slider
              value={[brightnessMax]}
              onValueChange={([v]) => setBrightnessMax(v)}
              min={150}
              max={255}
              step={5}
            />
          </div>
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={!directory || startMutation.isPending || !!activeTask}
          className="w-full"
        >
          {startMutation.isPending ? '准备中...' : activeTask ? '任务运行中' : '开始质检'}
        </Button>
      </ConfigCard>

      {/* Progress */}
      {(activeTask || (lastTask && lastTask.status === 'completed')) && (
        <TaskProgressCard
          task={activeTask || lastTask!}
          progress={progress}
          onPause={activeTask ? () => api.tasks.pause(activeTask.id) : undefined}
          onCancel={activeTask ? () => api.tasks.cancel(activeTask.id) : undefined}
          extraStats={
            <div className="flex gap-4 text-[12px]">
              <span className="text-success">
                ✓ 通过 {progress?.passed_count ?? 0}
              </span>
              <span className="text-destructive">
                ✗ 淘汰 {progress?.failed_count ?? 0}
              </span>
            </div>
          }
        />
      )}

      {/* Results placeholder */}
      {lastTask?.status === 'completed' && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-3">质检结果</h3>
          <div className="text-[12px] text-foreground/40">
            任务完成，可在资产库中查看通过/淘汰的图片
          </div>
        </div>
      )}
    </div>
  )
}
