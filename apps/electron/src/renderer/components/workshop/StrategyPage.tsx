import { useState, useEffect } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { workshopPresetAtom } from '@/atoms/workshop'
import { SeedSelector } from './SeedSelector'
import { ParameterForm, type FieldConfig } from './ParameterForm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import type { ImageRecord } from '@/lib/types'

interface StrategyPageProps {
  taskType: string
  fields: FieldConfig[]
  maxSeedImages?: number
  strategyId?: string
}

export function StrategyPage({ taskType, fields, maxSeedImages, strategyId }: StrategyPageProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const [preset, setPreset] = useAtom(workshopPresetAtom)
  const queryClient = useQueryClient()
  const [seeds, setSeeds] = useState<ImageRecord[]>([])
  const [params, setParams] = useState<Record<string, any>>(() => {
    const defaults: Record<string, any> = {}
    fields.forEach((f) => { if (f.default !== undefined) defaults[f.name] = f.default })
    return defaults
  })
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const progress = useTaskProgress(activeTaskId)

  // Apply preset from CoverageMatrix
  useEffect(() => {
    if (preset && preset.strategy === taskType) {
      setParams((prev) => ({ ...prev, ...preset.params }))
      setPreset(null) // consume preset
    }
  }, [preset, taskType, setPreset])

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择项目')
      if (seeds.length === 0) throw new Error('请先选择种子图')
      const result = await api.tasks.create(taskType, {
        project_id: projectId,
        image_ids: seeds.map((s) => s.id),
        ...(strategyId ? { strategy_id: strategyId } : {}),
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
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={seeds.length === 0 || !projectId || startMutation.isPending || !!activeTaskId}
              onClick={() => startMutation.mutate()}
            >
              {startMutation.isPending ? '提交中...' : activeTaskId ? '任务运行中' : `开始生产 (${seeds.length} 张)`}
            </Button>
            <Button
              variant="outline"
              disabled={seeds.length === 0 || !projectId}
              onClick={() => setBatchOpen(true)}
            >
              批量配置
            </Button>
          </div>
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

      {/* Batch production dialog */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[15px]">批量生产配置</DialogTitle>
          </DialogHeader>
          <BatchConfig
            taskType={taskType}
            fields={fields}
            seeds={seeds}
            projectId={projectId || ''}
            onSubmitted={() => {
              setBatchOpen(false)
              queryClient.invalidateQueries({ queryKey: ['tasks'] })
              toast.success('批量任务已提交')
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

function BatchConfig({ taskType, fields, seeds, projectId, onSubmitted }: {
  taskType: string
  fields: FieldConfig[]
  seeds: ImageRecord[]
  projectId: string
  onSubmitted: () => void
}) {
  // For each select field, allow multi-value selection
  const selectFields = fields.filter((f) => f.type === 'select' && f.options)
  const [selectedValues, setSelectedValues] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {}
    selectFields.forEach((f) => { init[f.name] = [String(f.default || f.options?.[0] || '')] })
    return init
  })

  const toggleValue = (fieldName: string, value: string) => {
    setSelectedValues((prev) => {
      const current = prev[fieldName] || []
      if (current.includes(value)) {
        return { ...prev, [fieldName]: current.filter((v) => v !== value) }
      }
      return { ...prev, [fieldName]: [...current, value] }
    })
  }

  // Calculate total tasks = seeds × combinations
  const combinations = selectFields.reduce((acc, f) => acc * (selectedValues[f.name]?.length || 1), 1)
  const totalTasks = seeds.length * combinations

  const batchMutation = useMutation({
    mutationFn: async () => {
      // Generate all param combinations
      const paramSets: Record<string, any>[] = [{}]
      for (const field of selectFields) {
        const values = selectedValues[field.name] || []
        const expanded: Record<string, any>[] = []
        for (const ps of paramSets) {
          for (const v of values) {
            expanded.push({ ...ps, [field.name]: v })
          }
        }
        paramSets.length = 0
        paramSets.push(...expanded)
      }

      const tasks = paramSets.map((ps) => ({
        type: taskType,
        project_id: projectId,
        parameters: { image_ids: seeds.map((s) => s.id), ...ps },
      }))

      return api.tasks.createBatch(tasks)
    },
    onSuccess: onSubmitted,
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="space-y-4 py-2">
      <div className="text-[13px] text-foreground/60">
        种子图: <span className="font-medium text-foreground/80">{seeds.length} 张</span>
      </div>

      {selectFields.map((field) => (
        <div key={field.name}>
          <label className="text-[12px] text-foreground/50 mb-2 block">{field.label} (可多选)</label>
          <div className="flex flex-wrap gap-1.5">
            {field.options?.map((opt) => {
              const selected = selectedValues[field.name]?.includes(opt)
              return (
                <button
                  key={opt}
                  onClick={() => toggleValue(field.name, opt)}
                  className={`px-2.5 py-1 rounded-md text-[12px] border transition-colors ${
                    selected
                      ? 'bg-accent/10 border-accent/40 text-accent'
                      : 'border-foreground/10 text-foreground/50 hover:border-foreground/20'
                  }`}
                >
                  {opt}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      <div className="rounded-md bg-foreground/[0.03] p-3 text-[12px] text-foreground/50">
        预计生成: {seeds.length} 张种子图 × {combinations} 组参数 = <span className="font-medium text-foreground/70">{totalTasks} 个任务</span>
      </div>

      <DialogFooter>
        <Button
          disabled={totalTasks === 0 || batchMutation.isPending}
          onClick={() => batchMutation.mutate()}
        >
          {batchMutation.isPending ? '提交中...' : `提交 ${totalTasks} 个任务`}
        </Button>
      </DialogFooter>
    </div>
  )
}
