import { useAtom, useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronsLeft,
  ChevronsRight,
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

interface NavItem {
  id: ModuleId
  title: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', title: '仪表盘', icon: LayoutDashboard },
  { id: 'pipeline', title: '流水线', icon: GitBranch },
  { id: 'ai-workshop', title: 'AI工坊', icon: Wand2 },
  { id: 'task-center', title: '任务中心', icon: ListTodo },
  { id: 'asset-library', title: '资产库', icon: FolderOpen },
  { id: 'coverage-matrix', title: '覆盖矩阵', icon: Grid3X3 },
  { id: 'match-lab', title: '匹配实验室', icon: FlaskConical },
  { id: 'distribution-center', title: '分发中心', icon: Share2 },
  { id: 'settings', title: '设置', icon: Settings },
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
      fetch(`http://localhost:7879/api/stats/recent-images?hours=24${projectId ? `&project_id=${projectId}` : ''}`)
        .then((r) => r.json()),
    refetchInterval: 60_000,
    enabled: !!projectId,
  })
  const recentBadges: Partial<Record<ModuleId, number>> = {
    'asset-library': recent?.generated || 0,
  }

  return (
    <aside
      className={cn(
        'flex flex-col shrink-0 h-full border-r border-foreground/5 transition-[width] duration-200 ease-out',
        collapsed ? 'w-[52px]' : 'w-[200px]',
      )}
    >
      {/* Header — small (32px). The OS traffic-light area is handled by the
          global drag bar in AppShell, so this row only carries brand + toggle. */}
      <div className="flex items-center h-[32px] px-2 shrink-0">
        {!collapsed && (
          <span className="text-[12px] font-semibold text-foreground/75 ml-1.5 truncate flex-1">
            灵图
          </span>
        )}
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

      {/* Project selector — hidden when collapsed (no compact mode for it yet) */}
      {!collapsed && <ProjectSelector />}

      {/* Navigation */}
      <nav className={cn(
        'flex flex-col gap-0.5 py-2 flex-1 overflow-y-auto scrollbar-hide',
        collapsed ? 'px-1.5' : 'px-2',
      )}>
        {NAV_ITEMS.map((item) => {
          const isActive = activeModule === item.id
          const Icon = item.icon
          const badgeCount = recentBadges[item.id] || 0
          // Suppress badge while the user is on the page itself.
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
      </nav>
    </aside>
  )
}
