import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { taskCenterActiveTabAtom } from '@/atoms/ui-state'
import { activeProjectIdAtom } from '@/atoms/project'
import { TabPage } from '@/components/shared/TabPage'
import { TaskProgressCard } from '@/components/pipeline/TaskProgressCard'
import { DetailDrawer } from '@/components/shared/DetailDrawer'
import { Badge } from '@/components/ui/badge'
import { Play, Clock, CheckCircle, Copy, XCircle, Layers, Inbox } from 'lucide-react'
import type { TaskRecord } from '@/lib/types'
import { BatchList } from '@/components/task-center/BatchList'
import { EmptyState } from '@/components/shared/EmptyState'

const STATUS_MAP: Record<string, string[]> = {
  running: ['running'],
  queued: ['queued', 'paused'],
  completed: ['completed'],
  failed: ['failed', 'cancelled'],
}

const TASK_TYPE_LABELS: Record<string, string> = {
  scan: '图片扫描',
  quality_check: '质量检查',
  dedup: '去重',
  tag: 'AI打标',
  crop: '视角裁剪',
  upscale: '超分增强',
}

function TaskList({ statuses }: { statuses: string[] }) {
  const queryClient = useQueryClient()
  const [selectedTask, setSelectedTask] = useState<TaskRecord | null>(null)
  const projectId = useAtomValue(activeProjectIdAtom)

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', 'center', statuses, projectId],
    queryFn: async () => {
      const all = await api.tasks.list(projectId ? { project_id: projectId } : undefined)
      return all.filter((t: TaskRecord) => statuses.includes(t.status))
    },
    refetchInterval: 3000,
    enabled: !!projectId,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-foreground/[0.02] animate-pulse" />
        ))}
      </div>
    )
  }

  if (!tasks || tasks.length === 0) {
    const which = statuses.includes('running') ? '运行中' : statuses.includes('completed') ? '已完成' : ''
    return (
      <EmptyState
        compact
        icon={Inbox}
        title={`没有${which}的任务`}
        description="去流水线启动一次扫描 / 标注 / 嵌入，任务会出现在这里"
      />
    )
  }

  return (
    <>
      <div className="space-y-3">
        {tasks.map((task: TaskRecord) => (
          <div key={task.id} className="cursor-pointer" onClick={() => setSelectedTask(task)}>
            <TaskProgressCard
              task={task}
              onPause={
                task.status === 'running'
                  ? () => { api.tasks.pause(task.id); queryClient.invalidateQueries({ queryKey: ['tasks'] }) }
                  : undefined
              }
              onResume={
                task.status === 'paused'
                  ? () => { api.tasks.resume(task.id); queryClient.invalidateQueries({ queryKey: ['tasks'] }) }
                  : undefined
              }
              onCancel={
                task.status === 'running' || task.status === 'paused'
                  ? () => { api.tasks.cancel(task.id); queryClient.invalidateQueries({ queryKey: ['tasks'] }) }
                  : undefined
              }
              extraStats={
                <div className="flex items-center gap-2 text-[12px] text-foreground/50">
                  <Badge variant="secondary" className="text-[10px]">
                    {TASK_TYPE_LABELS[task.type] || task.type}
                  </Badge>
                  {task.created_at && (
                    <span>{new Date(task.created_at).toLocaleString('zh-CN')}</span>
                  )}
                </div>
              }
            />
          </div>
        ))}
      </div>

      <DetailDrawer
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        title={selectedTask ? (TASK_TYPE_LABELS[selectedTask.type] || selectedTask.type) : ''}
      >
        {selectedTask && (
          <div className="space-y-4 text-[13px]">
            <InfoRow label="任务ID" value={selectedTask.id} />
            <InfoRow label="类型" value={TASK_TYPE_LABELS[selectedTask.type] || selectedTask.type} />
            <InfoRow label="状态" value={selectedTask.status} />
            <InfoRow label="进度" value={`${selectedTask.processed} / ${selectedTask.total}`} />
            <InfoRow label="失败数" value={String(selectedTask.failed)} />
            {selectedTask.cost_usd > 0 && (
              <InfoRow label="费用" value={`$${selectedTask.cost_usd.toFixed(4)}`} />
            )}
            <InfoRow label="创建时间" value={selectedTask.created_at ? new Date(selectedTask.created_at).toLocaleString('zh-CN') : '—'} />
            {selectedTask.started_at && (
              <InfoRow label="开始时间" value={new Date(selectedTask.started_at).toLocaleString('zh-CN')} />
            )}
            {selectedTask.completed_at && (
              <InfoRow label="完成时间" value={new Date(selectedTask.completed_at).toLocaleString('zh-CN')} />
            )}
            {selectedTask.error_message && (
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-foreground/40">错误信息</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(selectedTask.error_message!)
                      toast.success('已复制错误信息')
                    }}
                    className="text-foreground/35 hover:text-foreground/75 inline-flex items-center gap-1 text-[10.5px]"
                    title="复制完整错误"
                  >
                    <Copy size={10} /> 复制
                  </button>
                </div>
                <p className="mt-1 p-2 rounded bg-destructive/10 text-destructive text-[12px] whitespace-pre-wrap select-text">
                  {selectedTask.error_message}
                </p>
              </div>
            )}
            {selectedTask.parameters && (
              <div>
                <span className="text-foreground/40">参数</span>
                <pre className="mt-1 p-2 rounded bg-foreground/[0.03] text-[11px] text-foreground/60 overflow-x-auto">
                  {JSON.stringify(JSON.parse(selectedTask.parameters), null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </DetailDrawer>
    </>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-foreground/40">{label}</span>
      <span className="text-foreground/70 text-right max-w-[60%] truncate">{value}</span>
    </div>
  )
}

export default function TaskCenter() {
  const [activeTab, setActiveTab] = useAtom(taskCenterActiveTabAtom)
  const projectId = useAtomValue(activeProjectIdAtom)

  // Fetch all tasks once to get badge counts(限当前项目)
  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all-for-badges', projectId],
    queryFn: () => api.tasks.list(projectId ? { project_id: projectId } : undefined),
    refetchInterval: 5000,
    enabled: !!projectId,
  })

  const countByStatus = (statuses: string[]) =>
    allTasks?.filter((t: TaskRecord) => statuses.includes(t.status)).length ?? 0

  const TABS = [
    {
      id: 'batches',
      label: '批次',
      icon: Layers,
      content: <BatchList />,
    },
    {
      id: 'running',
      label: '进行中',
      icon: Play,
      badge: countByStatus(['running']),
      content: <TaskList statuses={STATUS_MAP.running} />,
    },
    {
      id: 'queued',
      label: '排队中',
      icon: Clock,
      badge: countByStatus(['queued', 'paused']),
      content: <TaskList statuses={STATUS_MAP.queued} />,
    },
    {
      id: 'completed',
      label: '已完成',
      icon: CheckCircle,
      badge: countByStatus(['completed']),
      content: <TaskList statuses={STATUS_MAP.completed} />,
    },
    {
      id: 'failed',
      label: '失败',
      icon: XCircle,
      badge: countByStatus(['failed', 'cancelled']),
      content: <TaskList statuses={STATUS_MAP.failed} />,
    },
  ]

  return (
    <TabPage title="任务中心" tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
  )
}
