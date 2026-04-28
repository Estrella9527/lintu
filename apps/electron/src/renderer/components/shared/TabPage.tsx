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
      {/* Page Header — combined with tab bar to reduce vertical chrome */}
      <div className="flex items-center justify-between gap-6 px-5 h-[40px] shrink-0 border-b border-foreground/5">
        <div className="flex items-center gap-5 min-w-0 flex-1">
          <h1 className="text-[13px] font-semibold text-foreground/85 shrink-0">{title}</h1>
          <Tabs value={activeTab} onValueChange={onTabChange} className="min-w-0">
            <TabsList className="h-7 bg-transparent p-0 gap-1">
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="relative px-2.5 py-1 text-[12.5px] rounded-md data-[state=active]:bg-accent/10 data-[state=active]:text-accent data-[state=active]:shadow-none text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03] transition-colors"
                  >
                    <span className="flex items-center gap-1.5">
                      {Icon && <Icon size={13} strokeWidth={1.5} />}
                      {tab.label}
                      {tab.badge !== undefined && (
                        <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-foreground/[0.06] text-foreground/50 leading-none">
                          {tab.badge}
                        </span>
                      )}
                    </span>
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>

      {/* Tab Content */}
      <Tabs value={activeTab} onValueChange={onTabChange} className="flex flex-col flex-1 min-h-0">
        {tabs.map((tab) => (
          <TabsContent
            key={tab.id}
            value={tab.id}
            className="flex-1 min-h-0 px-5 py-4 overflow-y-auto"
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
