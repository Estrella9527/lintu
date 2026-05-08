import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Copy, Pause, Play, RotateCcw, Trash2, X, Layers } from 'lucide-react'

import { api, type BatchRunRecord, apiFetchRaw } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { activeModuleAtom } from '@/atoms/navigation'
import { batchClonePresetAtom } from '@/atoms/workshop'
import { BatchDetailDrawer } from '@/components/task-center/BatchDetailDrawer'
import { EmptyState } from '@/components/shared/EmptyState'

const STATUS_LABEL: Record<string, string> = {
  pending: '待启动',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-foreground/10 text-foreground/60',
  running: 'bg-info/15 text-info',
  paused: 'bg-warning/15 text-warning',
  completed: 'bg-success/15 text-success',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-foreground/10 text-foreground/60',
}

export function BatchList() {
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setClonePreset = useSetAtom(batchClonePresetAtom)
  const [selected, setSelected] = useState<BatchRunRecord | null>(null)
  const [cloning, setCloning] = useState<string | null>(null)

  const handleClone = async (b: BatchRunRecord) => {
    setCloning(b.id)
    try {
      const seeds = await Promise.all(
        b.seed_image_ids.map((id) =>
          apiFetchRaw(`/images/${id}`).then((r) => (r.ok ? r.json() : null))
        ),
      )
      const validSeeds = seeds.filter((x): x is NonNullable<typeof x> => x != null)
      if (validSeeds.length === 0) {
        toast.error('原批次种子图都已删除，无法复用')
        return
      }
      if (validSeeds.length < b.seed_image_ids.length) {
        toast.warning(`${b.seed_image_ids.length - validSeeds.length} 张种子已删除，已跳过`)
      }
      setClonePreset({
        taskType: b.task_type,
        name: b.name,
        seeds: validSeeds,
        promptIds: b.prompt_ids,
        concurrency: b.concurrency,
        maxRetry: b.max_retry,
        budgetUsd: b.budget_usd,
        providerChain: b.provider_chain,
      })
      setActiveModule('ai-workshop')
    } catch (e) {
      toast.error(`复用失败：${(e as Error).message}`)
    } finally {
      setCloning(null)
    }
  }

  const { data: batches, isLoading } = useQuery<BatchRunRecord[]>({
    queryKey: ['batches', projectId],
    queryFn: () => api.batches.list(projectId ? { project_id: projectId } : undefined),
    refetchInterval: 3000,
    enabled: !!projectId,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['batches'] })

  const pause = useMutation({
    mutationFn: (id: string) => api.batches.pause(id),
    onSuccess: () => { toast.success('已暂停'); invalidate() },
  })
  const resume = useMutation({
    mutationFn: (id: string) => api.batches.resume(id),
    onSuccess: () => { toast.success('已恢复'); invalidate() },
  })
  const cancel = useMutation({
    mutationFn: (id: string) => api.batches.cancel(id),
    onSuccess: () => { toast.success('已取消'); invalidate() },
  })
  const retryFailed = useMutation({
    mutationFn: (id: string) => api.batches.retryFailed(id),
    onSuccess: () => { toast.success('失败任务已重新排队'); invalidate() },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.batches.delete(id),
    onSuccess: () => { toast.success('批次已删除'); invalidate() },
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-32 rounded-lg bg-foreground/[0.02] animate-pulse" />
        ))}
      </div>
    )
  }

  if (!batches?.length) {
    return (
      <EmptyState
        icon={Layers}
        title="还没有批次"
        description="去 AI 工坊点「批量生产」启动一组任务，会出现在这里"
        action={{ label: '去 AI 工坊', onClick: () => setActiveModule('ai-workshop') }}
      />
    )
  }

  return (
    <>
      <div className="space-y-3">
        {batches.map((b) => (
          <BatchCard
            key={b.id}
            batch={b}
            onClick={() => setSelected(b)}
            onPause={b.status === 'running' ? () => pause.mutate(b.id) : undefined}
            onResume={(b.status === 'paused' || b.status === 'pending') ? () => resume.mutate(b.id) : undefined}
            onCancel={(b.status === 'running' || b.status === 'paused') ? () => cancel.mutate(b.id) : undefined}
            onRetryFailed={b.failed > 0 && b.status !== 'running' ? () => retryFailed.mutate(b.id) : undefined}
            onClone={() => handleClone(b)}
            cloning={cloning === b.id}
            onDelete={b.status !== 'running' ? () => {
              if (confirm(`确认删除批次「${b.name}」？所有 subtask 也会一并删除。`)) {
                remove.mutate(b.id)
              }
            } : undefined}
          />
        ))}
      </div>

      <BatchDetailDrawer
        batch={selected}
        onClose={() => setSelected(null)}
      />
    </>
  )
}

function BatchCard({ batch, onClick, onPause, onResume, onCancel, onRetryFailed, onClone, cloning, onDelete }: {
  batch: BatchRunRecord
  onClick: () => void
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  onRetryFailed?: () => void
  onClone?: () => void
  cloning?: boolean
  onDelete?: () => void
}) {
  const total = batch.total || 1
  const done = batch.completed + batch.failed + batch.skipped
  const pct = Math.min(100, Math.round((done / total) * 100))

  return (
    <div
      onClick={onClick}
      className="rounded-lg border border-foreground/8 p-4 hover:border-foreground/15 hover:bg-foreground/[0.01] cursor-pointer transition-colors"
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[14px] font-medium text-foreground/90 truncate">{batch.name}</span>
            <Badge className={`text-[10px] px-1.5 py-0 ${STATUS_COLOR[batch.status] || ''}`}>
              {STATUS_LABEL[batch.status] || batch.status}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{batch.task_type}</Badge>
          </div>
          <div className="text-[11px] text-foreground/50">
            {batch.seed_image_ids.length} 种子 × {batch.prompt_ids.length} prompt = {batch.total} 张
            {batch.budget_usd != null && (
              <span className="ml-2">· 预算 ${Number(batch.budget_usd).toFixed(2)}</span>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {onPause && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onPause} title="暂停">
              <Pause size={13} />
            </Button>
          )}
          {onResume && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onResume} title="恢复">
              <Play size={13} />
            </Button>
          )}
          {onRetryFailed && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onRetryFailed} title="重试失败">
              <RotateCcw size={13} />
            </Button>
          )}
          {onClone && (
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0"
              onClick={onClone}
              disabled={cloning}
              title="用此批次的种子/Prompt/参数开新批次"
            >
              <Copy size={13} className={cloning ? 'animate-pulse' : ''} />
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-foreground/60" onClick={onCancel} title="取消">
              <X size={13} />
            </Button>
          )}
          {onDelete && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={onDelete} title="删除">
              <Trash2 size={13} />
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-foreground/[0.06] overflow-hidden mb-2">
        <div
          className={
            batch.status === 'completed' ? 'h-full bg-success/70' :
            batch.status === 'failed' ? 'h-full bg-destructive/70' :
            'h-full bg-info/70'
          }
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex items-center gap-4 text-[11px] text-foreground/55">
        <span><span className="text-foreground/85 font-medium">{done}</span> / {total} ({pct}%)</span>
        <span className="text-success">✓ {batch.completed}</span>
        {batch.failed > 0 && <span className="text-destructive">✗ {batch.failed}</span>}
        {batch.skipped > 0 && <span className="text-warning">⊘ {batch.skipped}</span>}
        <span>已用 ${Number(batch.cost_usd ?? 0).toFixed(4)}</span>
        {batch.created_at && (
          <span className="ml-auto text-foreground/40">
            {new Date(batch.created_at).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            })}
          </span>
        )}
      </div>
    </div>
  )
}
