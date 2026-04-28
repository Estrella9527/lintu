import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { Button } from '@/components/ui/button'
import { ConfigCard } from '@/components/pipeline/ConfigCard'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { TaskRecord } from '@/lib/types'

const MODES = [
  { value: 'auto', label: '自动纠正（EXIF）', desc: '免费，只处理 EXIF orientation tag' },
  { value: 'auto+ai', label: 'EXIF + AI 辅助', desc: 'EXIF 无果时用通用模型判断方向（消耗 AI 额度）' },
  { value: 'rotate_cw', label: '顺时针 90°', desc: '所有选中图片顺时针旋转 90°' },
  { value: 'rotate_ccw', label: '逆时针 90°', desc: '所有选中图片逆时针旋转 90°' },
  { value: 'rotate_180', label: '旋转 180°', desc: '所有选中图片旋转 180°' },
]

export function OrientTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [mode, setMode] = useState('auto')
  const [maxAi, setMaxAi] = useState(500)

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'orient'],
    queryFn: () => api.tasks.list({ type: 'orient' }),
    refetchInterval: 3000,
  })

  const activeTask = tasks?.find((t: TaskRecord) => t.status === 'running' || t.status === 'queued')
  const lastTask = tasks?.[0]
  const progress = useTaskProgress(activeTask?.id ?? null)

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择项目')
      return api.tasks.create('orient', {
        project_id: projectId,
        mode,
        ...(mode === 'auto+ai' ? { max_ai_images: maxAi } : {}),
      } as any)
    },
    onSuccess: () => {
      toast.success('视角纠正任务已启动')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4">
      <ConfigCard>
        <div className="space-y-3">
          <label className="text-[12px] text-foreground/50">纠正模式</label>
          <div className="grid grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  mode === m.value
                    ? 'border-accent/40 bg-accent/5'
                    : 'border-foreground/5 hover:border-foreground/10'
                }`}
              >
                <div className="text-[13px] font-medium text-foreground/80">{m.label}</div>
                <div className="text-[11px] text-foreground/40 mt-0.5">{m.desc}</div>
              </button>
            ))}
          </div>

          {mode === 'auto+ai' && (
            <div className="space-y-1 rounded-md bg-info/5 border border-info/20 p-3">
              <label className="text-[12px] text-foreground/60">
                本次 AI 额度上限：<span className="text-foreground/80 tabular-nums">{maxAi}</span> 张
              </label>
              <input
                type="range"
                min={50}
                max={2000}
                step={50}
                value={maxAi}
                onChange={(e) => setMaxAi(Number(e.target.value))}
                className="w-full"
              />
              <p className="text-[10px] text-foreground/50">
                只处理 EXIF 无效的图片；已经 AI 判过的自动跳过。
                使用「设置 → AI 服务商 → 模型分配」里选中的<strong>通用模型</strong>判断方向。
              </p>
            </div>
          )}
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={!projectId || startMutation.isPending || !!activeTask}
          className="w-full mt-3"
        >
          {activeTask ? '任务运行中' : '开始纠正'}
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
              <span className="text-success">✓ 已纠正 {(progress as any)?.fixed ?? 0}</span>
              <span className="text-foreground/40">跳过 {(progress as any)?.skipped ?? 0}</span>
              {(progress as any)?.ai_calls ? (
                <span className="text-info">AI {(progress as any).ai_calls}</span>
              ) : null}
            </div>
          }
        />
      )}

      {lastTask?.status === 'completed' && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/60 mb-2">纠正结果</h3>
          <p className="text-[12px] text-foreground/40">
            已完成，可在资产库中查看纠正后的图片
          </p>
        </div>
      )}
    </div>
  )
}
