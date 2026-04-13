import { useAtomValue } from 'jotai'
import { activeModuleAtom, type ModuleId } from '@/atoms/navigation'
import { LeftSidebar } from './LeftSidebar'
import { TopBar } from './TopBar'

import Dashboard from '@/pages/Dashboard'
import Pipeline from '@/pages/Pipeline'
import AIWorkshop from '@/pages/AIWorkshop'
import TaskCenter from '@/pages/TaskCenter'
import AssetLibrary from '@/pages/AssetLibrary'
import CoverageMatrix from '@/pages/CoverageMatrix'
import DistributionCenter from '@/pages/DistributionCenter'
import SettingsPage from '@/pages/Settings'

const PAGE_MAP: Record<ModuleId, React.ComponentType> = {
  dashboard: Dashboard,
  pipeline: Pipeline,
  'ai-workshop': AIWorkshop,
  'task-center': TaskCenter,
  'asset-library': AssetLibrary,
  'coverage-matrix': CoverageMatrix,
  'distribution-center': DistributionCenter,
  settings: SettingsPage,
}

export function AppShell() {
  const activeModule = useAtomValue(activeModuleAtom)
  const PageComponent = PAGE_MAP[activeModule]

  return (
    <div className="flex h-full w-full bg-background">
      <LeftSidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <PageComponent />
        </main>
      </div>
    </div>
  )
}
