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
import { cn } from '@/lib/utils'
import type { TaskRecord } from '@/lib/types'

const MODES = [
  {
    id: 'strict',
    label: '严格',
    desc: '阈值 4 · 几乎一模一样才合并',
    threshold: 4,
  },
  {
    id: 'balanced',
    label: '平衡（推荐）',
    desc: '阈值 6 · 90% 相似都会合并',
    threshold: 6,
  },
  {
    id: 'aggressive',
    label: '激进',
    desc: '阈值 10 · 角度/裁切变化也合并',
    threshold: 10,
  },
  {
    id: 'custom',
    label: '自定义',
    desc: '手动调整阈值',
    threshold: null,
  },
] as const

const SEMANTIC_MODES = [
  { id: 'strict', label: '严格', threshold: 0.92, desc: '≥0.92 · 几乎同一机位' },
  { id: 'balanced', label: '平衡（推荐）', threshold: 0.88, desc: '≥0.88 · 同场景不同主体也合并（比如同一吉祥物不同游客）' },
  { id: 'aggressive', label: '激进', threshold: 0.82, desc: '≥0.82 · 同主题场景都合并' },
] as const

export function DedupTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [modeId, setModeId] = useState<typeof MODES[number]['id']>('balanced')
  const [customThreshold, setCustomThreshold] = useState(8)
  const [useSemantic, setUseSemantic] = useState(false)
  const [semanticModeId, setSemanticModeId] = useState<typeof SEMANTIC_MODES[number]['id']>('balanced')

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

  const currentMode = MODES.find((m) => m.id === modeId)!
  const effectiveThreshold = currentMode.threshold ?? customThreshold
  const currentSemantic = SEMANTIC_MODES.find((m) => m.id === semanticModeId)!

  const startMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('请先选择或创建项目')
      return api.tasks.create('dedup', {
        project_id: projectId,
        mode: modeId === 'custom' ? 'balanced' : modeId,
        threshold: effectiveThreshold,
        use_semantic: useSemantic,
        semantic_mode: semanticModeId,
        semantic_threshold: currentSemantic.threshold,
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
        <div className="space-y-3">
          <div>
            <label className="text-[12px] text-foreground/60">去重模式</label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModeId(m.id)}
                  className={cn(
                    'text-left rounded-md border p-2.5 transition-colors',
                    modeId === m.id
                      ? 'border-accent bg-accent/5'
                      : 'border-foreground/10 hover:border-foreground/20',
                  )}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[13px] font-medium text-foreground/85">{m.label}</span>
                    {m.threshold !== null && (
                      <span className="text-[10px] text-foreground/45 tabular-nums">≤ {m.threshold}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-foreground/50 leading-snug">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {modeId === 'custom' && (
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">
                自定义汉明距离阈值: <span className="text-foreground/80 tabular-nums">{customThreshold}</span>
              </label>
              <Slider
                value={[customThreshold]}
                onValueChange={([v]) => setCustomThreshold(v)}
                min={1}
                max={20}
                step={1}
              />
              <p className="text-[10px] text-foreground/40">
                越小越严；≤4 接近一模一样，≥10 同构图不同角度也会合并
              </p>
            </div>
          )}

          <div className="rounded-md bg-foreground/[0.02] px-3 py-2 text-[11px] text-foreground/55">
            三哈希 ensemble (pHash + dHash + aHash)，任意 2/3 命中视为重复；Union-Find
            分组保证传递性。保留规则按 分辨率 + 清晰度 + 文件大小 综合评分。
          </div>
        </div>

        {/* Semantic section */}
        <div className="mt-4 pt-4 border-t border-foreground/5 space-y-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={useSemantic}
              onChange={(e) => setUseSemantic(e.target.checked)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-foreground/85">
                启用语义相似度（CLIP）— 识别同场景不同主体
              </div>
              <p className="text-[11px] text-foreground/55 mt-0.5 leading-snug">
                用 CLIP 图像嵌入做余弦相似度比对。能抓到哈希抓不到的场景，如
                "同一吉祥物 + 同一机位，不同人物"、"同一过山车轨道不同时间段"。
                首次运行会为所有图片生成 embedding（Apple Silicon ~5-10 分钟 / 7000 张），之后复用。
              </p>
            </div>
          </label>

          {useSemantic && (
            <div className="ml-6 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {SEMANTIC_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSemanticModeId(m.id)}
                    className={cn(
                      'text-left rounded-md border p-2.5 transition-colors',
                      semanticModeId === m.id
                        ? 'border-info bg-info/5'
                        : 'border-foreground/10 hover:border-foreground/20',
                    )}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[12px] font-medium text-foreground/85">{m.label}</span>
                      <span className="text-[10px] text-foreground/45 tabular-nums">{m.threshold.toFixed(2)}</span>
                    </div>
                    <p className="text-[10px] text-foreground/50 leading-snug">{m.desc}</p>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-foreground/40">
                哈希命中 <strong>或</strong> 语义命中都会合并；不会重复触发。
              </p>
            </div>
          )}
        </div>

        <Button
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending || !!activeTask}
          className="w-full mt-3"
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
              <div className="text-[12px] text-foreground/40 flex items-center gap-3">
                <span>阶段: {
                  progress.phase === 'hashing' ? '计算感知哈希' :
                  progress.phase === 'grouping' ? '哈希分组' :
                  progress.phase === 'embedding' ? 'CLIP 嵌入' :
                  progress.phase === 'semantic' ? '语义分组' :
                  progress.phase === 'done' ? '完成' : progress.phase
                }</span>
                {progress.phase === 'embedding' && (progress as any).embed_total > 0 && (
                  <span className="text-info">
                    {(progress as any).embed_progress ?? 0} / {(progress as any).embed_total}
                  </span>
                )}
              </div>
            ) : null
          }
        />
      )}

      {lastTask?.status === 'completed' && (
        <div className="rounded-lg border border-foreground/5 p-4">
          <h3 className="text-[13px] font-medium text-foreground/70 mb-2">结果复核</h3>
          <p className="text-[12px] text-foreground/55 mb-2">
            去重已完成。如果想手动检查每个重复组里选的"保留"是否合意，到<strong> 资产库 → 相似组 </strong>逐组复核。
          </p>
        </div>
      )}
    </div>
  )
}
