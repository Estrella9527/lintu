import { useRef, useEffect, useCallback } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ImageCard } from './ImageCard'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImageRecord } from '@/lib/types'

const COLUMNS = 6
const GAP = 8
const PAGE_SIZE = 120

interface ImageGridProps {
  projectId: string
  search?: string
  status?: string
  sourceType?: string
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onSelectAll?: (ids: string[]) => void
  onClickImage: (image: ImageRecord) => void
}

export function ImageGrid({ projectId, search, status, sourceType, selectedIds, onToggleSelect, onSelectAll, onClickImage }: ImageGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const selectionMode = selectedIds.size > 0

  const { data, fetchNextPage, hasNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['images', projectId, search, status, sourceType],
    queryFn: ({ pageParam = 0 }) =>
      api.images.list({
        project_id: projectId,
        offset: pageParam as number,
        limit: PAGE_SIZE,
        search: search || undefined,
        status: status && status !== 'all' ? status : undefined,
        source_type: sourceType && sourceType !== 'all' ? sourceType : undefined,
      }),
    getNextPageParam: (lastPage, pages) =>
      lastPage.items.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    initialPageParam: 0,
  })

  const allImages = data?.pages.flatMap((p) => p.items) ?? []
  const total = data?.pages[0]?.total ?? 0

  const handleSelectAll = useCallback(() => {
    if (onSelectAll) onSelectAll(allImages.map((img) => img.id))
  }, [allImages, onSelectAll])

  if (isLoading) {
    return (
      <div className="grid grid-cols-6 gap-2">
        {Array.from({ length: 18 }).map((_, i) => (
          <div key={i} className="aspect-square rounded-md bg-foreground/[0.03] animate-pulse" />
        ))}
      </div>
    )
  }

  if (allImages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-foreground/30 text-[13px]">
        <p>暂无图片</p>
        <p className="text-[12px] mt-1">在流水线中选择目录并执行扫描以导入图片</p>
      </div>
    )
  }

  const allSelected = allImages.length > 0 && allImages.every((img) => selectedIds.has(img.id))
  const someSelected = selectedIds.size > 0 && !allSelected

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSelectAll}
            className={cn(
              'w-4 h-4 rounded-sm border flex items-center justify-center transition-all',
              allSelected
                ? 'bg-accent border-accent text-white'
                : someSelected
                  ? 'bg-accent/30 border-accent text-white'
                  : 'border-foreground/20 hover:border-foreground/40',
            )}
          >
            {(allSelected || someSelected) && <Check size={10} strokeWidth={3} />}
          </button>
          <span className="text-[12px] text-foreground/40">
            {selectedIds.size > 0 ? `已选 ${selectedIds.size} / ${total.toLocaleString()} 张` : `共 ${total.toLocaleString()} 张图片`}
          </span>
        </div>
      </div>
      <div
        ref={parentRef}
        className="overflow-auto"
        style={{ height: 'calc(100vh - 290px)' }}
      >
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${COLUMNS}, 1fr)` }}
        >
          {allImages.map((img) => (
            <ImageCard
              key={img.id}
              image={img}
              selected={selectedIds.has(img.id)}
              selectionMode={selectionMode}
              onClick={() => onClickImage(img)}
              onToggleSelect={() => onToggleSelect(img.id)}
            />
          ))}
        </div>
        {hasNextPage && (
          <LoadMoreTrigger onVisible={() => fetchNextPage()} />
        )}
      </div>
    </div>
  )
}

/** Intersection observer trigger to load more pages */
function LoadMoreTrigger({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisible() },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [onVisible])
  return <div ref={ref} className="h-4" />
}
