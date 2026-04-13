import { useState } from 'react'
import { TabPage } from '@/components/shared/TabPage'
import { Cog, Cpu, FileText, Tags, Cloud, Info } from 'lucide-react'

const TABS = [
  {
    id: 'general',
    label: '通用',
    icon: Cog,
    content: (
      <div className="space-y-6 max-w-2xl">
        <section>
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">数据目录</h3>
          <div className="rounded-md border border-foreground/5 p-3 text-[13px] text-foreground/40">
            ~/lintu-data
          </div>
        </section>
        <section>
          <h3 className="text-[13px] font-medium text-foreground/80 mb-3">主题</h3>
          <div className="flex gap-2">
            <div className="w-8 h-8 rounded-md bg-background border border-foreground/10 cursor-pointer" title="浅色" />
            <div className="w-8 h-8 rounded-md bg-[oklch(0.145_0.015_270)] border border-foreground/10 cursor-pointer" title="深色" />
          </div>
        </section>
      </div>
    ),
  },
  {
    id: 'ai-provider',
    label: 'AI服务商',
    icon: Cpu,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        Gemini / 即梦 / 通义 / ComfyUI 接入配置
      </div>
    ),
  },
  {
    id: 'prompt-library',
    label: '提示词库',
    icon: FileText,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        Prompt 模板管理与参数预设
      </div>
    ),
  },
  {
    id: 'tag-system',
    label: '标签体系',
    icon: Tags,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        7维度标签的 CRUD 管理
      </div>
    ),
  },
  {
    id: 'oss-config',
    label: 'OSS连接',
    icon: Cloud,
    content: (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
        分发目标 OSS/CDN 配置
      </div>
    ),
  },
  {
    id: 'about',
    label: '关于',
    icon: Info,
    content: (
      <div className="max-w-md">
        <h3 className="text-[15px] font-semibold text-foreground mb-2">灵图</h3>
        <p className="text-[13px] text-foreground/50 mb-4">
          景区图片 AI 生产平台
        </p>
        <div className="space-y-1 text-[12px] text-foreground/40">
          <p>版本: 0.1.0</p>
          <p>技术栈: Electron + React + Tailwind</p>
        </div>
      </div>
    ),
  },
]

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general')
  return (
    <TabPage
      title="设置"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  )
}
