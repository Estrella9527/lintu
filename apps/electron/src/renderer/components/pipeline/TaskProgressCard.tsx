import { useMemo } from 'react'
import { Pause, Play, X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTaskProgress } from '@/hooks/useTaskProgress'
import type { TaskRecord, TaskProgressEvent } from '@/lib/types'

interface TaskProgressCardProps {
  task: TaskRecord
  /** External progress override. When omitted and the task is running, the
   * card opens its OWN SSE subscription so multiple concurrent tasks each
   * stream live. Pass `null` explicitly to opt out. */
  progress?: TaskProgressEvent | null
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  extraStats?: React.ReactNode
}

export function TaskProgressCard({
  task,
  progress: externalProgress,
  onPause,
  onResume,
  onCancel,
  extraStats,
}: TaskProgressCardProps) {
  const isRunning = task.status === 'running'
  const isPaused = task.status === 'paused'
  // Auto-subscribe when no external progress was provided AND the task is
  // running. `externalProgress === undefined` means "not passed" (parent
  // didn't opt out, so this card owns its stream). `null` from the parent
  // means "no live stream" (don't open one).
  const ownProgress = useTaskProgress(
    externalProgress === undefined && isRunning ? task.id : null,
  )
  const progress = externalProgress !== undefined ? externalProgress : ownProgress

  // Monotonic merge against DB-stored values: progress event might be stale
  // by up to one tick relative to the polled task row, so take the max.
  const processed = Math.max(progress?.processed ?? 0, task.processed ?? 0)
  const totalRaw = Math.max(progress?.total ?? 0, task.total ?? 0)
  const total = totalRaw || 0
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0

  // Optional human-friendly label stored at task creation time, e.g.
  //   "AI打标 · 秋季漂流封面 · 42 张"
  // Lets the user tell prompt-A's tag task apart from prompt-B's when many
  // are running at once.
  const customLabel = useMemo(() => {
    try {
      const params = JSON.parse(task.parameters || '{}')
      return typeof params.label === 'string' ? params.label : null
    } catch {
      return null
    }
  }, [task.parameters])

  return (
    <div className="rounded-lg border border-foreground/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${
              isRunning ? 'bg-success animate-pulse' : isPaused ? 'bg-info' : 'bg-foreground/20'
            }`}
          />
          <span className="text-[13px] font-medium text-foreground/80 shrink-0">
            {isRunning ? '运行中' : isPaused ? '已暂停' : task.status === 'completed' ? '已完成' : task.status}
          </span>
          {customLabel && (
            <span
              className="text-[12px] text-foreground/60 truncate"
              title={customLabel}
            >
              · {customLabel}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {isRunning && onPause && (
            <Button variant="ghost" size="sm" onClick={onPause} className="h-7 px-2 text-[12px]">
              <Pause size={12} className="mr-1" /> 暂停
            </Button>
          )}
          {isPaused && onResume && (
            <Button variant="ghost" size="sm" onClick={onResume} className="h-7 px-2 text-[12px]">
              <Play size={12} className="mr-1" /> 继续
            </Button>
          )}
          {(isRunning || isPaused) && onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 px-2 text-[12px] text-destructive">
              <X size={12} className="mr-1" /> 取消
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="h-2 bg-foreground/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-foreground/40 tabular-nums">
          <span>{pct}% ({processed.toLocaleString()} / {total.toLocaleString()})</span>
          {task.cost_usd > 0 && <span>${task.cost_usd.toFixed(4)}</span>}
        </div>
      </div>

      {/* Extra stats */}
      {extraStats}
    </div>
  )
}
