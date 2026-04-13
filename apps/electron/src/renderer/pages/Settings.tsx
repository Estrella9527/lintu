import { useState } from 'react'
import { Cog, Cpu, FileText, Tags, Cloud, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GeneralTab } from './settings/GeneralTab'
import { AIProviderTab } from './settings/AIProviderTab'
import { TagSchemaTab } from './settings/TagSchemaTab'
import { PromptLibraryTab } from './settings/PromptLibraryTab'

const TABS = [
  { id: 'general', label: '通用', icon: Cog },
  { id: 'ai-provider', label: 'AI服务商', icon: Cpu },
  { id: 'prompt-library', label: '提示词库', icon: FileText },
  { id: 'tag-system', label: '标签体系', icon: Tags },
  { id: 'oss-config', label: 'OSS连接', icon: Cloud },
  { id: 'about', label: '关于', icon: Info },
]

function TabContent({ id }: { id: string }) {
  switch (id) {
    case 'general': return <GeneralTab />
    case 'ai-provider': return <AIProviderTab />
    case 'prompt-library': return <PromptLibraryTab />
    case 'tag-system': return <TagSchemaTab />
    case 'oss-config': return (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        分发目标 OSS/CDN 配置
      </div>
    )
    case 'about': return (
      <div className="max-w-md">
        <h3 className="text-[15px] font-semibold text-foreground mb-2">灵图</h3>
        <p className="text-[13px] text-foreground/50 mb-4">景区图片 AI 生产平台</p>
        <div className="space-y-1 text-[12px] text-foreground/40">
          <p>版本: 0.1.0</p>
          <p>技术栈: Electron + React + Tailwind</p>
        </div>
      </div>
    )
    default: return null
  }
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 h-[48px] shrink-0 border-b border-foreground/5">
        <h1 className="text-[15px] font-semibold text-foreground">设置</h1>
      </div>

      {/* Tab bar - plain buttons, no Radix */}
      <div className="px-6 pt-3 shrink-0">
        <div className="flex gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon
            const isActive = activeTab === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                )}
              >
                <Icon size={14} strokeWidth={1.5} />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content - conditional render */}
      <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
        <TabContent id={activeTab} />
      </div>
    </div>
  )
}
