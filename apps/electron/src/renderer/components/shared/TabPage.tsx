import type { ReactNode } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { LucideIcon } from 'lucide-react'
import { ErrorBoundary } from './ErrorBoundary'

export interface TabConfig {
  id: string
  label: string
  icon?: LucideIcon
  badge?: string | number
  content: ReactNode
}

interface TabPageProps {
  title: string
  tabs: TabConfig[]
  activeTab: string
  onTabChange: (tab: string) => void
  actions?: ReactNode
}

export function TabPage({ title, tabs, activeTab, onTabChange, actions }: TabPageProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Page Header */}
      <div className="flex items-center justify-between px-6 h-[48px] shrink-0 border-b border-foreground/5">
        <h1 className="text-[15px] font-semibold text-foreground">{title}</h1>
        {actions && <div className="flex items-center gap-2 titlebar-no-drag">{actions}</div>}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col flex-1 min-h-0">
        <div className="px-6 pt-3 pb-0 shrink-0">
          <TabsList className="h-9 bg-transparent p-0 gap-1">
            {tabs.map((tab) => {
              const Icon = tab.icon
              return (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="relative px-3 py-1.5 text-[13px] rounded-md data-[state=active]:bg-accent/10 data-[state=active]:text-accent data-[state=active]:shadow-none text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03] transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {Icon && <Icon size={14} strokeWidth={1.5} />}
                    {tab.label}
                    {tab.badge !== undefined && (
                      <span className="ml-1 px-1.5 py-0.5 text-[11px] rounded-full bg-foreground/[0.06] text-foreground/50 leading-none">
                        {tab.badge}
                      </span>
                    )}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>

        {/* Tab Content */}
        {tabs.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            className="flex-1 min-h-0 px-6 py-4 overflow-y-auto"
            forceMount={undefined}
          >
            <ErrorBoundary fallbackMessage={`"${tab.label}" 加载出错`}>
              {tab.content}
            </ErrorBoundary>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
