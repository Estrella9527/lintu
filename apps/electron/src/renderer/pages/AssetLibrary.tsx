import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TabPage } from '@/components/shared/TabPage'
import { LayoutGrid, GitFork, Star, Trash2 } from 'lucide-react'
import { ImageGrid } from '@/components/asset-library/ImageGrid'
import { FilterBar, type FilterState } from '@/components/asset-library/FilterBar'
import { ImageDetailDrawer } from '@/components/asset-library/ImageDetailDrawer'
import type { ImageRecord } from '@/lib/types'

export default function AssetLibrary() {
  const [activeTab, setActiveTab] = useState('all')
  const [filter, setFilter] = useState<FilterState>({ search: '', status: 'all' })
  const [selectedImage, setSelectedImage] = useState<ImageRecord | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Get first project
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => fetch('http://localhost:7879/api/projects').then((r) => r.json()),
  })
  const projectId = projects?.[0]?.id

  const handleSelectImage = (img: ImageRecord) => {
    setSelectedImage(img)
    setDrawerOpen(true)
  }

  const TABS = [
    {
      id: 'all',
      label: '全部图片',
      icon: LayoutGrid,
      content: projectId ? (
        <div>
          <FilterBar filter={filter} onChange={setFilter} />
          <ImageGrid
            projectId={projectId}
            search={filter.search || undefined}
            status={filter.status !== 'all' ? filter.status : undefined}
            onSelectImage={handleSelectImage}
          />
        </div>
      ) : (
        <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30">
          请先在流水线中选择目录并扫描图片
        </div>
      ),
    },
    {
      id: 'derivatives',
      label: '衍生关系',
      icon: GitFork,
      content: (
        <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
          图谱可视化（V3.0 预留）
        </div>
      ),
    },
    {
      id: 'favorites',
      label: '收藏夹',
      icon: Star,
      content: (
        <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
          已收藏的精选图片
        </div>
      ),
    },
    {
      id: 'trash',
      label: '回收站',
      icon: Trash2,
      content: projectId ? (
        <ImageGrid
          projectId={projectId}
          status="rejected"
          onSelectImage={handleSelectImage}
        />
      ) : (
        <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
          暂无淘汰图片
        </div>
      ),
    },
  ]

  return (
    <>
      <TabPage
        title="资产库"
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <ImageDetailDrawer
        image={selectedImage}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  )
}
