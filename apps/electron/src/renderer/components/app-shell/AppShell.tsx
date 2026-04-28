import { useAtomValue } from 'jotai'
import { activeModuleAtom, type ModuleId } from '@/atoms/navigation'
import { LeftSidebar } from './LeftSidebar'

import Dashboard from '@/pages/Dashboard'
import Pipeline from '@/pages/Pipeline'
import AIWorkshop from '@/pages/AIWorkshop'
import TaskCenter from '@/pages/TaskCenter'
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
          <PageComponent />
        </main>
      </div>
    </div>
  )
}
