import { Pause, Play, X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TaskRecord, TaskProgressEvent } from '@/lib/types'

interface TaskProgressCardProps {
  task: TaskRecord
  progress: TaskProgressEvent | null
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
  extraStats?: React.ReactNode
}

export function TaskProgressCard({
  task,
  progress,
  onPause,
  onResume,
  onCancel,
  extraStats,
}: TaskProgressCardProps) {
  const processed = progress?.processed ?? task.processed
  const total = progress?.total ?? task.total
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0
  const isRunning = task.status === 'running'
  const isPaused = task.status === 'paused'

  return (
    <div className="rounded-lg border border-foreground/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isRunning ? 'bg-success animate-pulse' : isPaused ? 'bg-info' : 'bg-foreground/20'
            }`}
          />
          <span className="text-[13px] font-medium text-foreground/80">
            {isRunning ? '运行中' : isPaused ? '已暂停' : task.status === 'completed' ? '已完成' : task.status}
          </span>
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
