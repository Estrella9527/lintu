import { useAtom, useAtomValue } from 'jotai'
import { Building2, Cloud, Cog, Cpu, FileText, Info, Palette, ScrollText, ShieldCheck, Tags, Users, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { settingsTabAtom, type SettingsTabId } from '@/atoms/navigation'
import { activeOrgAtom } from '@/atoms/auth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { GeneralTab } from './settings/GeneralTab'
import { AIProviderTab } from './settings/AIProviderTab'
import { TagSchemaTab } from './settings/TagSchemaTab'
import { PromptLibraryTab } from './settings/PromptLibraryTab'
import { MembersTab } from './settings/MembersTab'
import { OrgGeneralTab } from './settings/OrgGeneralTab'
import { OrgMembersTab } from './settings/OrgMembersTab'
import { PlatformTab } from './settings/PlatformTab'
import { AuditLogTab } from './settings/AuditLogTab'
import { OSSConnectTab } from './settings/OSSConnectTab'
import { AboutTab } from './settings/AboutTab'
import { StyleArchiveTab } from './settings/StyleArchiveTab'

interface NavItem {
  id: SettingsTabId
  label: string
  icon: LucideIcon
  /** 仅 platform owner 可见 */
  platformOnly?: boolean
  /** 仅当组织里 owner / admin 可见（普通 member 隐藏） */
  orgAdminOnly?: boolean
}

interface NavSection {
  label: string
  /** 显示在分组标题旁的范围 tooltip,告诉用户里面的配置作用范围 */
  hint?: string
  items: NavItem[]
}

const SECTIONS: NavSection[] = [
  {
    label: '组织',
    hint: '影响整个组织 · 所有项目共享',
    items: [
      { id: 'org-general',  label: '组织设置',  icon: Building2, orgAdminOnly: true },
      { id: 'org-members',  label: '组织成员',  icon: Users, orgAdminOnly: true },
      { id: 'platform',     label: '平台管理',  icon: ShieldCheck, platformOnly: true },
    ],
  },
  {
    label: '当前项目',
    hint: '仅影响当前选中的项目 · 切项目会变',
    items: [
      { id: 'members',         label: '项目成员',   icon: Users },
      { id: 'style-archives',  label: '风格档案',   icon: Palette },
    ],
  },
  {
    label: '全局共享(所有项目共用)',
    hint: '所有项目共用一份 · 改一处全项目生效',
    items: [
      { id: 'ai-provider',    label: 'AI 服务商',  icon: Cpu },
      { id: 'prompt-library', label: '提示词库',   icon: FileText },
      { id: 'tag-system',     label: '标签体系',   icon: Tags },
      { id: 'oss-config',     label: 'OSS 连接',   icon: Cloud },
    ],
  },
  {
    label: '运维',
    items: [
      { id: 'audit-log',     label: '操作日志',   icon: ScrollText, orgAdminOnly: true },
    ],
  },
  {
    label: '应用',
    items: [
      { id: 'general',       label: '通用',       icon: Cog },
      { id: 'about',         label: '关于',       icon: Info },
    ],
  },
]

function TabContent({ id }: { id: SettingsTabId }) {
  switch (id) {
    case 'general': return <GeneralTab />
    case 'org-general': return <OrgGeneralTab />
    case 'org-members': return <OrgMembersTab />
    case 'platform': return <PlatformTab />
    case 'ai-provider': return <AIProviderTab />
    case 'prompt-library': return <PromptLibraryTab />
    case 'tag-system': return <TagSchemaTab />
    case 'style-archives': return <StyleArchiveTab />
    case 'members': return <MembersTab />
    case 'audit-log': return <AuditLogTab />
    case 'oss-config': return <OSSConnectTab />
    case 'about': return <AboutTab />
    default: return null
  }
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom)
  const user = useCurrentUser()
  const activeOrg = useAtomValue(activeOrgAtom)

  // 按权限过滤：platformOnly → 仅 platform owner；orgAdminOnly → 仅 owner/admin（platform owner 视为 owner）
  const isPlatformOwner = !!user?.is_platform_owner
  const isOrgAdmin = isPlatformOwner ||
    activeOrg?.my_role === 'owner' ||
    activeOrg?.my_role === 'admin'

  const sections = SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items.filter((it) => {
      if (it.platformOnly && !isPlatformOwner) return false
      if (it.orgAdminOnly && !isOrgAdmin) return false
      return true
    }),
  })).filter((sec) => sec.items.length > 0)

  const allItems = sections.flatMap((s) => s.items)
  const current = allItems.find((it) => it.id === activeTab) ?? allItems[0]

  return (
    <div className="flex h-full">
      {/* Left: secondary nav */}
      <aside className="w-[220px] shrink-0 border-r border-foreground/5 flex flex-col">
        <div className="px-5 h-[40px] flex items-center shrink-0">
          <h1 className="text-[13px] font-semibold text-foreground/85">设置</h1>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
          {sections.map((sec) => (
            <div key={sec.label}>
              <div
                className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-foreground/35"
                title={sec.hint || undefined}
              >
                {sec.label}
              </div>
              <div className="space-y-0.5">
                {sec.items.map((item) => {
                  const Icon = item.icon
                  const active = activeTab === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      className={cn(
                        'w-full text-left rounded-md px-2.5 py-1.5 transition-colors flex items-center gap-2',
                        active
                          ? 'bg-foreground/[0.07] text-foreground'
                          : 'text-foreground/65 hover:bg-foreground/[0.03] hover:text-foreground/85',
                      )}
                    >
                      <Icon size={14} strokeWidth={active ? 2 : 1.5} className="shrink-0" />
                      <span className="text-[12.5px] font-medium truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Right: detail */}
      <section className="flex-1 min-w-0 flex flex-col">
        <header className="px-6 h-[40px] flex items-center shrink-0 border-b border-foreground/5">
          <h2 className="text-[13px] font-medium text-foreground/85">{current?.label ?? ''}</h2>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {current && <TabContent id={current.id} />}
        </div>
      </section>
    </div>
  )
}
