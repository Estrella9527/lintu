import { useAtomValue } from 'jotai'
import { activeModuleAtom, type ModuleId } from '@/atoms/navigation'
import { LeftSidebar } from './LeftSidebar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'

import Dashboard from '@/pages/Dashboard'
import Pipeline from '@/pages/Pipeline'
import AIWorkshop from '@/pages/AIWorkshop'
import TaskCenter from '@/pages/TaskCenter'
import ReviewQueue from '@/pages/ReviewQueue'
import AssetLibrary from '@/pages/AssetLibrary'
import CoverageMatrix from '@/pages/CoverageMatrix'
import MatchLab from '@/pages/MatchLab'
import DistributionCenter from '@/pages/DistributionCenter'
import SettingsPage from '@/pages/Settings'

const PAGE_MAP: Record<ModuleId, React.ComponentType> = {
  dashboard: Dashboard,
  pipeline: Pipeline,
  'ai-workshop': AIWorkshop,
  'task-center': TaskCenter,
  'review-queue': ReviewQueue,
  'asset-library': AssetLibrary,
  'coverage-matrix': CoverageMatrix,
  'match-lab': MatchLab,
  'distribution-center': DistributionCenter,
  settings: SettingsPage,
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

export function AppShell() {
  const activeModule = useAtomValue(activeModuleAtom)
  const PageComponent = PAGE_MAP[activeModule]

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Single global drag region across the whole top — gives macOS traffic
          lights horizontal room without each panel needing to negotiate it. */}
      {isMac && (
        <div className="titlebar-drag-region h-[28px] w-full shrink-0" />
      )}

      <div className="flex flex-1 min-h-0">
        <LeftSidebar />
        <main className="flex-1 min-w-0 overflow-hidden">
          {/* `key` resets the boundary's internal state when the user
              switches modules, so a crash in one module doesn't poison
              the next page they navigate to. */}
          <ErrorBoundary key={activeModule} fallbackMessage={`「${activeModule}」页面渲染出错`}>
            <PageComponent />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
