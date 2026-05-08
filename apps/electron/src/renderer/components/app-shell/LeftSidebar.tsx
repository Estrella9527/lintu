import { useAtom, useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Grid3X3,
  LayoutDashboard,
  ListTodo,
  Settings,
  Share2,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import { activeModuleAtom, sidebarCollapsedAtom, type ModuleId } from '@/atoms/navigation'
import { activeProjectIdAtom } from '@/atoms/project'
import { cn } from '@/lib/utils'
import { ProjectSelector } from './ProjectSelector'
import { apiFetchRaw } from '@/lib/api'
import { UserBadge } from './UserBadge'
import { OrgSwitcher } from './OrgSwitcher'

interface NavItem {
  id: ModuleId
  title: string
  icon: LucideIcon
}

interface NavGroup {
  /** 组标题；展开态显示 uppercase 灰字，收起态隐藏只留分隔线。 */
  label: string
  items: NavItem[]
}

// 分组 + 排序按 v0.2 菜单方案：
//   工作台（高频日常） · 6 项
//   图片运营（中低频深度） · 3 项
//   系统 · 1 项
//
// 「资产库」从原第 6 位提到第 2 位 — 是核心数据视图，应紧跟仪表盘；
// 「流水线」后置 — 是初始化阶段才高频使用；
// 「覆盖矩阵 / 匹配实验室 / 分发中心」分组到「图片运营」，跟日常生产分开。
const NAV_GROUPS: NavGroup[] = [
  {
    label: '工作台',
    items: [
      { id: 'dashboard',    title: '仪表盘',  icon: LayoutDashboard },
      { id: 'asset-library', title: '资产库',  icon: FolderOpen },
      { id: 'ai-workshop',  title: 'AI工坊',   icon: Wand2 },
      { id: 'pipeline',     title: '流水线',   icon: GitBranch },
      { id: 'task-center',  title: '任务中心', icon: ListTodo },
      { id: 'review-queue', title: '审核',     icon: ClipboardCheck },
    ],
  },
  {
    label: '图片运营',
    items: [
      { id: 'coverage-matrix',     title: '覆盖矩阵',   icon: Grid3X3 },
      { id: 'match-lab',           title: '匹配实验室', icon: FlaskConical },
      { id: 'distribution-center', title: '分发中心',   icon: Share2 },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'settings', title: '设置', icon: Settings },
    ],
  },
]

export function LeftSidebar() {
  const [activeModule, setActiveModule] = useAtom(activeModuleAtom)
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const projectId = useAtomValue(activeProjectIdAtom)

  // "近 24h N 张" badge on 资产库 — counts generated images created in the
  // last day. Refresh every minute, no need to be tighter than that.
  const { data: recent } = useQuery<{ generated: number }>({
    queryKey: ['recent-images-24h', projectId],
    queryFn: () =>
      apiFetchRaw(`/stats/recent-images?hours=24${projectId ? `&project_id=${projectId}` : ''}`)
        .then((r) => r.json()),
    refetchInterval: 60_000,
    enabled: !!projectId,
  })
  // Pending AI-generated images awaiting operator decision; drives the
  // 「审核」 badge so the operator sees backlog without opening the page.
  const { data: reviewCounts } = useQuery<Record<string, number>>({
    queryKey: ['review-counts', projectId],
    queryFn: () =>
      apiFetchRaw(`/image-review/counts${projectId ? `?project_id=${projectId}` : ''}`)
        .then((r) => r.json()),
    refetchInterval: 60_000,
    enabled: !!projectId,
  })

  const recentBadges: Partial<Record<ModuleId, number>> = {
    'asset-library': recent?.generated || 0,
    'review-queue':  reviewCounts?.pending || 0,
  }

  return (
    <aside
      className={cn(
        'flex flex-col shrink-0 h-full border-r border-foreground/5 transition-[width] duration-200 ease-out',
        collapsed ? 'w-[52px]' : 'w-[200px]',
      )}
    >
      {/* Header — collapse toggle only. 品牌区已被 OrgSwitcher 顶替（见下） */}
      <div className="flex items-center h-[32px] px-2 shrink-0 justify-end">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className={cn(
            'h-6 w-6 rounded-md flex items-center justify-center text-foreground/45 hover:text-foreground hover:bg-foreground/[0.05] transition-colors',
            collapsed && 'mx-auto',
          )}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          {collapsed ? <ChevronsRight size={13} /> : <ChevronsLeft size={13} />}
        </button>
      </div>

      {/* 组织切换器 — 取代原品牌区，超管能在这里切组织 / 创建新组织 */}
      <div className={cn('shrink-0', collapsed ? 'px-1' : 'px-2')}>
        <OrgSwitcher collapsed={collapsed} />
      </div>

      {/* Project selector — hidden when collapsed (no compact mode for it yet) */}
      {!collapsed && <ProjectSelector />}

      {/* Navigation */}
      <nav className={cn(
        'flex flex-col py-2 flex-1 overflow-y-auto scrollbar-hide',
        collapsed ? 'px-1.5' : 'px-2',
      )}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            {/* 组分隔：第一组没有分隔线；后续组有 */}
            {gi > 0 && (
              collapsed ? (
                // 收起态只画一条细线
                <div className="my-2 mx-2 border-t border-foreground/8" aria-hidden />
              ) : (
                // 展开态：组标题（uppercase 灰字），跟分隔线一起替代单纯的 spacer
                <div className="mt-3 mb-1 px-2 text-[10px] uppercase tracking-wide text-foreground/35 select-none">
                  {group.label}
                </div>
              )
            )}
            {/* 第一组在展开态也显示标题，节奏统一 */}
            {gi === 0 && !collapsed && (
              <div className="mb-1 px-2 text-[10px] uppercase tracking-wide text-foreground/35 select-none">
                {group.label}
              </div>
            )}

            {group.items.map((item) => {
              const isActive = activeModule === item.id
              const Icon = item.icon
              const badgeCount = recentBadges[item.id] || 0
              const showBadge = badgeCount > 0 && !isActive
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveModule(item.id)}
                  className={cn(
                    'relative flex items-center rounded-[6px] text-[12.5px] w-full transition-colors',
                    collapsed
                      ? 'justify-center h-8'
                      : 'gap-2 px-2 py-[6px] text-left',
                    isActive
                      ? 'bg-foreground/[0.07] text-foreground font-medium'
                      : 'text-foreground/60 hover:bg-sidebar-hover hover:text-foreground/80',
                  )}
                  title={collapsed ? item.title : undefined}
                  aria-label={item.title}
                >
                  <Icon
                    size={collapsed ? 16 : 14}
                    strokeWidth={isActive ? 2 : 1.5}
                    className="shrink-0"
                    style={{
                      color: isActive
                        ? 'var(--foreground)'
                        : 'color-mix(in oklch, var(--foreground) 60%, transparent)',
                    }}
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{item.title}</span>
                      {showBadge && (
                        <span
                          className="ml-auto text-[10px] tabular-nums px-1.5 py-0 rounded-full bg-info/15 text-info"
                          title={`近 24h 新增 ${badgeCount} 张生成图`}
                        >
                          {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                      )}
                    </>
                  )}
                  {collapsed && showBadge && (
                    <span
                      className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-info"
                      title={`近 24h 新增 ${badgeCount} 张生成图`}
                    />
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* 用户徽章 — 钉在侧栏底部，常驻显示 */}
      <div className={cn('shrink-0 border-t border-foreground/5 py-2', collapsed ? 'px-1.5' : 'px-2')}>
        <UserBadge collapsed={collapsed} />
      </div>
    </aside>
  )
}
