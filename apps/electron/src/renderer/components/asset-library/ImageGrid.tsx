import { useRef, useEffect } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '@/lib/api'
import { ImageCard } from './ImageCard'
import type { ImageRecord } from '@/lib/types'

const COLUMNS = 6
const ROW_HEIGHT = 180
const PAGE_SIZE = 120

interface ImageGridProps {
  projectId: string
  search?: string
  status?: string
  onSelectImage: (image: ImageRecord) => void
}

export function ImageGrid({ projectId, search, status, onSelectImage }: ImageGridProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  const { data, fetchNextPage, hasNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['images', projectId, search, status],
    queryFn: ({ pageParam = 0 }) =>
      api.images.list({
        project_id: projectId,
        offset: pageParam as number,
        limit: PAGE_SIZE,
        search: search || undefined,
        status: status && status !== 'all' ? status : undefined,
      }),
    getNextPageParam: (lastPage, pages) =>
      lastPage.items.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    initialPageParam: 0,
  })

  const allImages = data?.pages.flatMap((p) => p.items) ?? []
  const total = data?.pages[0]?.total ?? 0
  const rowCount = Math.ceil(allImages.length / COLUMNS)

  const rowVirtualizer = useVirtualizer({
    count: hasNextPage ? rowCount + 1 : rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
  })

  // Load more when scrolling near bottom
  useEffect(() => {
    const items = rowVirtualizer.getVirtualItems()
    const lastRow = items[items.length - 1]
    if (lastRow && lastRow.index >= rowCount - 1 && hasNextPage) {
      fetchNextPage()
    }
  }, [rowVirtualizer.getVirtualItems(), hasNextPage, rowCount, fetchNextPage])

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

  return (
    <div>
      <div className="text-[12px] text-foreground/40 mb-2">
        共 {total.toLocaleString()} 张图片
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto" style={{ height: 'calc(100vh - 240px)' }}>
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const rowImages = allImages.slice(
              virtualRow.index * COLUMNS,
              (virtualRow.index + 1) * COLUMNS,
            )
            return (
              <div
                key={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="grid grid-cols-6 gap-2 px-0"
              >
                {rowImages.map((img) => (
                  <ImageCard
                    key={img.id}
                    image={img}
                    onClick={() => onSelectImage(img)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
