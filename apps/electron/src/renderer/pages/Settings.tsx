import { useAtom } from 'jotai'
import { Cloud, Cog, Cpu, FileText, Info, Tags, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { settingsTabAtom, type SettingsTabId } from '@/atoms/navigation'
import { GeneralTab } from './settings/GeneralTab'
import { AIProviderTab } from './settings/AIProviderTab'
import { TagSchemaTab } from './settings/TagSchemaTab'
import { PromptLibraryTab } from './settings/PromptLibraryTab'
import { AboutTab } from './settings/AboutTab'

interface NavItem {
  id: SettingsTabId
  label: string
  desc: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general',         label: '通用',       desc: '工作区、外观、偏好', icon: Cog },
  { id: 'ai-provider',     label: 'AI 服务商',  desc: '模型分配、Provider 凭证', icon: Cpu },
  { id: 'prompt-library',  label: '提示词库',   desc: 'Prompt 管理、文档导入', icon: FileText },
  { id: 'tag-system',      label: '标签体系',   desc: '维度与取值', icon: Tags },
  { id: 'oss-config',      label: 'OSS 连接',   desc: '分发目标', icon: Cloud },
  { id: 'about',           label: '关于',       desc: '版本与许可', icon: Info },
]

function TabContent({ id }: { id: SettingsTabId }) {
  switch (id) {
    case 'general': return <GeneralTab />
    case 'ai-provider': return <AIProviderTab />
    case 'prompt-library': return <PromptLibraryTab />
    case 'tag-system': return <TagSchemaTab />
    case 'oss-config': return (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        分发目标 OSS / CDN 配置（开发中）
      </div>
    )
    case 'about': return <AboutTab />

    default: return null
  }
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom)
  const current = NAV_ITEMS.find((it) => it.id === activeTab) ?? NAV_ITEMS[0]

  return (
    <div className="flex h-full">
      {/* Left: secondary nav (Craft Agent style) */}
      <aside className="w-[220px] shrink-0 border-r border-foreground/5 flex flex-col">
        <div className="px-5 h-[40px] flex items-center shrink-0">
          <h1 className="text-[13px] font-semibold text-foreground/85">设置</h1>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  'w-full text-left rounded-md px-2.5 py-1.5 transition-colors flex items-start gap-2',
                  active
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'text-foreground/65 hover:bg-foreground/[0.03] hover:text-foreground/85',
                )}
              >
                <Icon
                  size={14}
                  strokeWidth={active ? 2 : 1.5}
                  className="shrink-0 mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium leading-tight">{item.label}</div>
                  <div className="text-[10.5px] text-foreground/45 leading-tight mt-0.5 truncate">
                    {item.desc}
                  </div>
                </div>
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Right: detail */}
      <section className="flex-1 min-w-0 flex flex-col">
        <header className="px-6 h-[40px] flex items-center shrink-0 border-b border-foreground/5">
          <h2 className="text-[13px] font-medium text-foreground/85">{current.label}</h2>
          <span className="text-[11px] text-foreground/45 ml-3">{current.desc}</span>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <TabContent id={activeTab} />
        </div>
      </section>
    </div>
  )
}
