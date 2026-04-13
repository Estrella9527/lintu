import { useAtom } from 'jotai'
import {
  LayoutDashboard,
  GitBranch,
  Wand2,
  ListTodo,
  FolderOpen,
  Grid3X3,
  Share2,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { activeModuleAtom, type ModuleId } from '@/atoms/navigation'
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
  { id: 'distribution-center', title: '分发中心', icon: Share2 },
  { id: 'settings', title: '设置', icon: Settings },
]

export function LeftSidebar() {
  const [activeModule, setActiveModule] = useAtom(activeModuleAtom)

  return (
    <aside className="flex flex-col w-[220px] shrink-0 h-full border-r border-foreground/5">
      {/* Logo area */}
      <div className="titlebar-drag-region flex items-center h-[42px] px-4">
        <span className="titlebar-no-drag text-[13px] font-semibold text-foreground/80">
          灵图
        </span>
      </div>

      {/* Project selector */}
      <ProjectSelector />

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5 px-2 py-2 flex-1 overflow-y-auto scrollbar-hide">
        {NAV_ITEMS.map((item) => {
          const isActive = activeModule === item.id
          const Icon = item.icon
          return (
            <button
              key={item.id}
              onClick={() => setActiveModule(item.id)}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-[7px] rounded-[6px] text-[13px] w-full text-left transition-colors',
                isActive
                  ? 'bg-foreground/[0.07] text-foreground font-medium'
                  : 'text-foreground/60 hover:bg-sidebar-hover hover:text-foreground/80',
              )}
            >
              <Icon
                size={15}
                strokeWidth={isActive ? 2 : 1.5}
                className="shrink-0"
                style={{
                  color: isActive
                    ? 'var(--foreground)'
                    : 'color-mix(in oklch, var(--foreground) 60%, transparent)',
                }}
              />
              {item.title}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}
