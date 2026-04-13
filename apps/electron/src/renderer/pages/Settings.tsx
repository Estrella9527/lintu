import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import { Cog, Cpu, FileText, Tags, Cloud, Info } from 'lucide-react'
import { GeneralTab } from './settings/GeneralTab'
import { AIProviderTab } from './settings/AIProviderTab'

const PLACEHOLDER = (text: string) => (
  <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
    {text}
  </div>
)

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')

  const TABS = [
    { id: 'general', label: '通用', icon: Cog, content: <GeneralTab /> },
    { id: 'ai-provider', label: 'AI服务商', icon: Cpu, content: <AIProviderTab /> },
    { id: 'prompt-library', label: '提示词库', icon: FileText, content: PLACEHOLDER('Prompt 模板管理与参数预设') },
    { id: 'tag-system', label: '标签体系', icon: Tags, content: PLACEHOLDER('7维度标签的 CRUD 管理') },
    { id: 'oss-config', label: 'OSS连接', icon: Cloud, content: PLACEHOLDER('分发目标 OSS/CDN 配置') },
    {
      id: 'about', label: '关于', icon: Info, content: (
        <div className="max-w-md">
          <h3 className="text-[15px] font-semibold text-foreground mb-2">灵图</h3>
          <p className="text-[13px] text-foreground/50 mb-4">景区图片 AI 生产平台</p>
          <div className="space-y-1 text-[12px] text-foreground/40">
            <p>版本: 0.1.0</p>
            <p>技术栈: Electron + React + Tailwind</p>
          </div>
        </div>
      ),
    },
  ]

  return (
    <TabPage title="设置" tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
  )
}
