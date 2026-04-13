import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import { Play, Clock, CheckCircle, XCircle } from 'lucide-react'

const TABS = [
  {
    id: 'running',
    label: '进行中',
    icon: Play,
    badge: 0,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        暂无运行中的任务
      </div>
    ),
  },
  {
    id: 'queued',
    label: '排队中',
    icon: Clock,
    badge: 0,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        暂无排队中的任务
      </div>
    ),
  },
  {
    id: 'completed',
    label: '已完成',
    icon: CheckCircle,
    badge: 0,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        暂无已完成的任务
      </div>
    ),
  },
  {
    id: 'failed',
    label: '失败',
    icon: XCircle,
    badge: 0,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        暂无失败的任务
      </div>
    ),
  },
]

export default function TaskCenter() {
  const [activeTab, setActiveTab] = useState('running')
  return (
    <TabPage
      title="任务中心"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
