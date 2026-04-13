import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import { Cloud, Download, Globe, History } from 'lucide-react'

const TABS = [
  {
    id: 'oss',
    label: 'OSS同步',
    icon: Cloud,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        OSS 同步队列与配置
      </div>
    ),
  },
  {
    id: 'export',
    label: '导出预设',
    icon: Download,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        小红书 / 朋友圈 / OTA 各规格导出预设
      </div>
    ),
  },
  {
    id: 'cdn',
    label: 'CDN管理',
    icon: Globe,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        域名配置与 URL 生成器
      </div>
    ),
  },
  {
    id: 'history',
    label: '同步历史',
    icon: History,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        操作日志与同步记录
      </div>
    ),
  },
]

export default function DistributionCenter() {
  const [activeTab, setActiveTab] = useState('oss')
  return (
    <TabPage
      title="分发中心"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
