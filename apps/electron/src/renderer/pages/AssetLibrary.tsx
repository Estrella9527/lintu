import { useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { LayoutGrid, GitFork, Star, Trash2 } from 'lucide-react'
import { ImageGrid } from '@/components/asset-library/ImageGrid'
import { FilterBar, type FilterState } from '@/components/asset-library/FilterBar'
import { ImageDetailDrawer } from '@/components/asset-library/ImageDetailDrawer'
import { BatchActionBar } from '@/components/asset-library/BatchActionBar'
import { activeProjectIdAtom } from '@/atoms/project'
import type { ImageRecord } from '@/lib/types'

const TABS = [
  { id: 'all', label: '全部图片', icon: LayoutGrid },
  { id: 'derivatives', label: '衍生关系', icon: GitFork },
  { id: 'favorites', label: '收藏夹', icon: Star },
  { id: 'trash', label: '回收站', icon: Trash2 },
]

export default function AssetLibrary() {
  const [activeTab, setActiveTab] = useState('all')
  const [filter, setFilter] = useState<FilterState>({ search: '', status: 'all' })
  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const projectId = useAtomValue(activeProjectIdAtom)

  const handleClickImage = useCallback((img: ImageRecord) => {
    setSelectedImage(img)
    setDrawerOpen(true)
  }, [])

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleClearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const gridStatus = activeTab === 'trash' ? 'rejected' : (filter.status !== 'all' ? filter.status : undefined)

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-6 h-[48px] shrink-0 border-b border-foreground/5">
          <h1 className="text-[15px] font-semibold text-foreground">资产库</h1>
        </div>

        {/* Tab bar */}
        <div className="px-6 pt-3 shrink-0">
          <div className="flex gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); handleClearSelection() }}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors',
                    isActive
                      ? 'bg-accent/10 text-accent'
                      : 'text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                  )}
                >
                  <Icon size={14} strokeWidth={1.5} />
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
          {activeTab === 'all' || activeTab === 'trash' ? (
            projectId ? (
              <div>
                {activeTab === 'all' && <FilterBar filter={filter} onChange={setFilter} />}
                <BatchActionBar
                  selectedCount={selectedIds.size}
                  selectedIds={selectedIds}
                  onClear={handleClearSelection}
                />
                <ImageGrid
                  projectId={projectId}
                  search={activeTab === 'all' ? (filter.search || undefined) : undefined}
                  status={gridStatus}
                  selectedIds={selectedIds}
                  onToggleSelect={handleToggleSelect}
                  onClickImage={handleClickImage}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30">
                请先在流水线中选择目录并扫描图片
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
              {activeTab === 'derivatives' ? '图谱可视化（V3.0 预留）' : '收藏夹功能开发中'}
            </div>
          )}
        </div>
      </div>

      <ImageDetailDrawer
        image={selectedImage}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}
