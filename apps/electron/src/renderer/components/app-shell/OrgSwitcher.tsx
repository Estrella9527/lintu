import { useState } from 'react'
import { useAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { Building2, Check, ChevronsUpDown, Plus, Settings } from 'lucide-react'

import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import {
  activeOrgIdAtom, currentUserAtom, myOrgsAtom, type CurrentOrgSummary,
} from '@/atoms/auth'
import { activeModuleAtom, settingsTabAtom } from '@/atoms/navigation'
import { cn } from '@/lib/utils'
import { CreateOrgDialog } from './CreateOrgDialog'

/**
 * 组织切换器 — 顶替原来左下角的「灵图」品牌区。
 *
 * 单组织时仅展示组织名（点击进入组织设置）；多组织时展开下拉切换。
 * Platform owner 在底部多一个「创建新组织」入口。
 *
 * 切换组织 = 改 activeOrgIdAtom + 清掉所有 react-query cache（避免拿到旧数据）。
 */
interface Props {
  collapsed: boolean
}

export function OrgSwitcher({ collapsed }: Props) {
  const [user] = useAtom(currentUserAtom)
  const [orgs] = useAtom(myOrgsAtom)
  const [activeId, setActiveId] = useAtom(activeOrgIdAtom)
  const [, setActiveModule] = useAtom(activeModuleAtom)
  const [, setSettingsTab] = useAtom(settingsTabAtom)
  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const queryClient = useQueryClient()

  if (!user) return null

  const active = orgs.find((o) => o.id === activeId) ?? orgs[0] ?? null
  const canCreateOrg = !!user.is_platform_owner

  const handleSwitch = (org: CurrentOrgSummary) => {
    if (org.id === activeId) { setOpen(false); return }
    setActiveId(org.id)
    setOpen(false)
    // 切换组织后所有 query 都需要重拉 — 简单起见全清空
    queryClient.clear()
  }

  const goToOrgSettings = () => {
    setActiveModule('settings')
    setSettingsTab('org-general')
    setOpen(false)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/[0.04]',
              // min-w-0 配合 flex-1 让长名能 truncate；w-full 让按钮充满父容器
              collapsed ? 'w-9 mx-auto justify-center' : 'w-full min-w-0',
            )}
            title={active?.name || '选择组织'}
          >
            {/* logo / 占位 */}
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent/70 text-background overflow-hidden">
              {active?.logo_url ? (
                <img src={active.logo_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <Building2 size={13} strokeWidth={2.2} />
              )}
            </div>
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="text-[12.5px] font-semibold text-foreground/85 truncate">
                    {active?.name || '未选择组织'}
                  </div>
                  <div className="text-[10px] text-foreground/45 truncate">
                    {active ? `${roleLabel(active.my_role)} · ${active.project_count} 个项目` : '点击选择'}
                  </div>
                </div>
                <ChevronsUpDown size={12} className="text-foreground/40 shrink-0" />
              </>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={8} className="w-72 p-1">
          <div className="px-2 py-1.5 text-[10.5px] uppercase tracking-wide text-foreground/40">
            我的组织
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            {orgs.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-foreground/40 text-center">
                你还没加入任何组织
              </div>
            )}
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => handleSwitch(o)}
                title={o.name}
                className={cn(
                  'w-full min-w-0 text-left rounded-md px-2 py-1.5 flex items-center gap-2 transition-colors',
                  o.id === activeId
                    ? 'bg-accent/[0.08] text-foreground'
                    : 'text-foreground/75 hover:bg-foreground/[0.04]',
                )}
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent/60 to-accent/30 text-background overflow-hidden">
                  {o.logo_url ? (
                    <img src={o.logo_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Building2 size={11} />
                  )}
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="text-[12.5px] font-medium truncate">{o.name}</div>
                  <div className="text-[10px] text-foreground/45 truncate">
                    {roleLabel(o.my_role)} · {o.member_count} 成员 · {o.project_count} 项目
                  </div>
                </div>
                {o.id === activeId && <Check size={12} className="text-accent shrink-0" />}
              </button>
            ))}
          </div>
          <div className="border-t border-foreground/5 mt-1 pt-1">
            <Button
              variant="ghost" size="sm"
              onClick={goToOrgSettings}
              className="w-full justify-start text-foreground/75 hover:text-foreground text-[12px]"
            >
              <Settings size={12} className="mr-2" />组织设置
            </Button>
            {canCreateOrg && (
              <Button
                variant="ghost" size="sm"
                onClick={() => { setShowCreate(true); setOpen(false) }}
                className="w-full justify-start text-foreground/75 hover:text-foreground text-[12px]"
              >
                <Plus size={12} className="mr-2" />创建新组织
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <CreateOrgDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </>
  )
}

function roleLabel(role: string | null): string {
  switch (role) {
    case 'platform_owner': return '平台超管'
    case 'owner':          return '组织主'
    case 'admin':          return '管理员'
    case 'member':         return '成员'
    default:               return '未知'
  }
}
