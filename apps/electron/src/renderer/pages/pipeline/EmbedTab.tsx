import { useAtomValue, useSetAtom } from 'jotai'
import { activeModuleAtom } from '@/atoms/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api , apiFetchRaw } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import { Button } from '@/components/ui/button'
import { ConfigCard } from '@/components/pipeline/ConfigCard'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import { cn } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, Cpu, Database, Play, RefreshCw, Sparkles } from 'lucide-react'
import type { TaskRecord } from '@/lib/types'

const API_BASE = 'http://127.0.0.1:7879'

interface EmbedCoverage {
  total: number
  embedded: number
  missing: number
  by_model: { model: string; count: number }[]
  expected_tag: string
  aligned: number
  misaligned: number
  fully_aligned: boolean
}

export function EmbedTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const setActiveModule = useSetAtom(activeModuleAtom)

  const { data: coverage } = useQuery<EmbedCoverage>({
    queryKey: ['embed-coverage', projectId],
    queryFn: () => apiFetchRaw(`/stats/embed-coverage?project_id=${projectId || ''}`).then((r) => r.json()),
    refetchInterval: 5_000,
    enabled: !!projectId,
  })

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'embed'],
    queryFn: () => api.tasks.list({ type: 'embed' }),
    refetchInterval: 3_000,
  })
  const activeTask = tasks?.find((t: TaskRecord) => t.status === 'running' || t.status === 'queued')
  const pausedTask = !activeTask
    ? tasks?.find((t: TaskRecord) => t.status === 'paused')
    : undefined
  const lastTask = tasks?.[0]
  const progress = useTaskProgress(activeTask?.id ?? null)

  const startMutation = useMutation({
    mutationFn: async (force: boolean) => {
      if (!projectId) throw new Error('请先选择或创建项目')
      return api.tasks.create('embed', { project_id: projectId, force } as any)
    },
    onSuccess: (_d, force) => {
      toast.success(force ? '全库重建已启动' : 'Embed 任务已启动')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['embed-coverage'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // Resume a paused task (carries on from the last processed image without
  // re-embedding the ones already done).
  const resumeMutation = useMutation({
    mutationFn: async (taskId: string) => api.tasks.resume(taskId),
    onSuccess: () => {
      toast.success('已恢复向量化任务')
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['embed-coverage'] })
    },
    onError: (e: Error) => toast.error(`恢复失败：${e.message}`),
  })

  const cov = coverage
  const pct = cov && cov.total > 0 ? Math.round((cov.aligned / cov.total) * 100) : 0
  const needsRebuild = !!cov && cov.misaligned > 0

  return (
    <div className="space-y-4">
      {/* What is this for? — distinguishes from 打标 */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3">
        <div className="flex items-start gap-2">
          <Sparkles size={14} className="text-foreground/55 shrink-0 mt-0.5" />
          <div className="text-[12px] text-foreground/65 leading-relaxed">
            <strong className="text-foreground/85">向量化 (Embedding)</strong>：把每张图压缩成一组数学向量（数百到数千维数字）。
            <span className="text-foreground/45 ml-1">
              用途：(1) <strong>语义去重</strong>（视觉相似的图自动合组），
              (2) <strong>跨模态文图匹配</strong>（外部 UGC 应用用一段文字搜出相关图）。
            </span>
            <div className="text-[11px] text-foreground/45 mt-1">
              ↔ 与<strong>打标</strong>的区别：打标产出"场景/情绪/风格"等可读文本标签；
              向量化产出机器看的数学向量。两者互补，建议都跑。
            </div>
          </div>
        </div>
      </div>

      <ConfigCard>
        <div className="space-y-3">
          {/* Backend & coverage status */}
          <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3 space-y-2.5">
            <div className="flex items-center gap-2 text-[12.5px]">
              <Cpu size={13} className="text-foreground/55" />
              <span className="text-foreground/55">当前 embedding 后端</span>
              <code className="px-1.5 py-0.5 rounded bg-foreground/[0.05] text-[11px] font-mono text-foreground/85">
                {cov?.expected_tag || '未配置'}
              </code>
              {cov && (
                cov.fully_aligned ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-success">
                    <CheckCircle2 size={11} /> 全库已对齐
                  </span>
                ) : needsRebuild ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-warning">
                    <AlertTriangle size={11} /> 维度不匹配，需重建
                  </span>
                ) : (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-foreground/45">
                    <Database size={11} /> {cov.missing.toLocaleString()} 张待 embed
                  </span>
                )
              )}
            </div>

            {cov && (
              <>
                <div className="grid grid-cols-4 gap-3 text-[12px]">
                  <Stat label="总图" value={cov.total.toLocaleString()} />
                  <Stat label="已对齐" value={cov.aligned.toLocaleString()} tone="success" />
                  <Stat label="维度不匹配" value={cov.misaligned.toLocaleString()} tone={cov.misaligned > 0 ? 'warning' : 'muted'} />
                  <Stat label="未 embed" value={cov.missing.toLocaleString()} tone={cov.missing > 0 ? 'pending' : 'muted'} />
                </div>

                {cov.total > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[10.5px] text-foreground/45">
                      <span>对齐覆盖率</span>
                      <span className="tabular-nums">{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-foreground/[0.06] overflow-hidden">
                      <div
                        className={cn(
                          'h-full transition-all',
                          pct >= 95 ? 'bg-success/70' : pct >= 60 ? 'bg-warning/70' : 'bg-foreground/30',
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Per-model breakdown — surface mixed-dim libraries */}
                {cov.by_model.length > 1 && (
                  <div className="text-[10.5px] text-foreground/55 space-y-0.5 pt-1 border-t border-foreground/5">
                    <div className="text-foreground/40 mb-0.5">按 embedding 模型分布：</div>
                    {cov.by_model.map((b) => (
                      <div key={b.model} className="flex justify-between">
                        <code className="font-mono text-[10px]">{b.model}</code>
                        <span className="tabular-nums">
                          {b.count.toLocaleString()}
                          {b.model === cov.expected_tag && (
                            <span className="text-success ml-1">✓ 当前</span>
                          )}
                          {b.model !== cov.expected_tag && b.model !== '(unknown)' && (
                            <span className="text-warning ml-1">⚠ 需重建</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="text-[11px] text-foreground/45 leading-relaxed">
            提示：切换 embedding provider（如本地 CLIP → 火山方舟 Ark）后维度会变化，
            需<strong className="text-warning">全库重建</strong>才能正常工作。
          </div>
        </div>

        <div className="flex gap-2 mt-3">
          <Button
            onClick={() => startMutation.mutate(false)}
            disabled={startMutation.isPending || !!activeTask || !cov || cov.missing === 0}
            className="flex-1"
          >
            {activeTask
              ? 'Embed 任务运行中'
              : `Embed 缺失图片（${cov?.missing.toLocaleString() ?? 0} 张）`}
          </Button>
          <Button
            variant={needsRebuild ? 'default' : 'outline'}
            onClick={() => {
              if (!cov || cov.total === 0) return
              const msg =
                `全库重建会重新计算所有 ${cov.total.toLocaleString()} 张图片的 embedding，\n` +
                `用当前 backend「${cov.expected_tag}」覆盖现有向量。\n\n` +
                (needsRebuild
                  ? `当前有 ${cov.misaligned.toLocaleString()} 张维度不匹配，必须重建才能启用文图匹配。`
                  : `当前已全部对齐，重建仅在切换 provider / 验证一致性时需要。`)
              if (confirm(msg + '\n\n继续？')) {
                startMutation.mutate(true)
              }
            }}
            disabled={startMutation.isPending || !!activeTask || !cov || cov.total === 0}
            className={cn(needsRebuild && 'border-warning/40')}
          >
            <RefreshCw size={13} className="mr-1.5" />
            全库重建
          </Button>
        </div>
      </ConfigCard>

      {/* Paused task — surface explicitly with a Resume CTA. Without this,
          a half-finished task would silently sit in the DB and the user
          might think the system "loaded but did nothing". */}
      {pausedTask && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-[13px] font-semibold text-foreground/85">向量化任务已暂停</h3>
                <span className="text-[10px] text-foreground/45 tabular-nums">
                  {pausedTask.processed} / {pausedTask.total}
                  {pausedTask.failed > 0 && (
                    <span className="text-destructive ml-1">（{pausedTask.failed} 失败）</span>
                  )}
                </span>
              </div>
              <p className="text-[11.5px] text-foreground/55 leading-relaxed">
                上次任务停在 {Math.round((pausedTask.processed / Math.max(1, pausedTask.total)) * 100)}%。
                点击恢复继续处理剩下的 <strong className="text-foreground/75">{Math.max(0, pausedTask.total - pausedTask.processed)}</strong> 张图片。
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => resumeMutation.mutate(pausedTask.id)}
              disabled={resumeMutation.isPending}
              className="shrink-0"
            >
              <Play size={12} className="mr-1" />
              {resumeMutation.isPending ? '恢复中…' : '恢复任务'}
            </Button>
          </div>
        </div>
      )}

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
                  progress.phase === 'embedding' ? '计算 embedding' :
                  progress.phase === 'done' ? '完成' : progress.phase
                }</span>
                {(progress as any).ok != null && (
                  <span className="text-success">成功 {(progress as any).ok}</span>
                )}
                {(progress as any).failed > 0 && (
                  <span className="text-destructive">失败 {(progress as any).failed}</span>
                )}
              </div>
            ) : null
          }
        />
      )}

      {lastTask?.status === 'completed' && cov?.fully_aligned && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-4">
          <h3 className="text-[13px] font-medium text-success mb-1 inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} /> 全库已对齐
          </h3>
          <p className="text-[12px] text-foreground/55 mb-3">
            外部 Open API 的<strong>文图匹配</strong>端点（<code className="px-1 bg-foreground/[0.04] rounded">POST /open-api/v1/images/match</code>）
            的跨模态语义召回现已启用。
          </p>
          <Button
            variant="outline" size="sm" className="h-8 text-[12px]"
            onClick={() => setActiveModule('asset-library')}
          >
            去试匹配
          </Button>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'success' | 'warning' | 'pending' | 'muted' }) {
  const color =
    tone === 'success' ? 'text-success'
    : tone === 'warning' ? 'text-warning'
    : tone === 'pending' ? 'text-warning'
    : tone === 'muted' ? 'text-foreground/55'
    : 'text-foreground/85'
  return (
    <div className="rounded-md bg-foreground/[0.025] px-3 py-2">
      <div className="text-[10.5px] text-foreground/50">{label}</div>
      <div className={cn('text-[14px] font-semibold tabular-nums mt-0.5', color)}>{value}</div>
    </div>
  )
}
