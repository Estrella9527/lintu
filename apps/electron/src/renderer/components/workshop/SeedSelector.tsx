import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'

import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { FolderTree } from '@/components/asset-library/FolderTree'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Check, FolderOpen, Search, Sparkles } from 'lucide-react'
import type { ImageRecord } from '@/lib/types'

interface SeedSelectorProps {
  selectedImages: ImageRecord[]
  onSelect: (images: ImageRecord[]) => void
  maxSelect?: number
}

const PAGE_SIZE = 100

export function SeedSelector({ selectedImages, onSelect, maxSelect }: SeedSelectorProps) {
  const [showPicker, setShowPicker] = useState(false)

  return (
    <>
      <div className="space-y-3">
        {/* Action row */}
        <div className="flex gap-2 items-center">
          <Button
            variant="outline" size="sm" className="text-[12px] h-8"
            onClick={() => setShowPicker(true)}
          >
            <FolderOpen size={13} className="mr-1.5" />
            从资产库选择 …
          </Button>
          {selectedImages.length > 0 && (
            <Button
              variant="ghost" size="sm" className="text-[11px] h-8 text-foreground/40"
              onClick={() => onSelect([])}
            >
              清空 ({selectedImages.length})
            </Button>
          )}
        </div>

        {/* Selected preview chips */}
        {selectedImages.length > 0 ? (
          <div>
            <div className="text-[12px] text-foreground/55 mb-2">
              已选 {selectedImages.length} 张{maxSelect ? ` / 最多 ${maxSelect} 张` : ''}
            </div>
            <div className="flex gap-2 flex-wrap">
              {selectedImages.slice(0, 12).map((img) => (
                <ThumbnailImage
                  key={img.id}
                  imageId={img.id}
                  size={128}
                  version={img.updated_at}
                  className="w-16 h-16 rounded-md"
                  onClick={() => onSelect(selectedImages.filter((s) => s.id !== img.id))}
                />
              ))}
              {selectedImages.length > 12 && (
                <div className="w-16 h-16 rounded-md bg-foreground/[0.04] flex items-center justify-center text-[12px] text-foreground/40">
                  +{selectedImages.length - 12}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-16 rounded-md bg-foreground/[0.02] text-[12px] text-foreground/30">
            点击上方按钮挑选种子图（支持文件夹/批量）
          </div>
        )}
      </div>

      <SeedPickerDialog
        open={showPicker}
        onClose={() => setShowPicker(false)}
        initialSelected={selectedImages}
        onConfirm={(imgs) => { onSelect(imgs); setShowPicker(false) }}
        maxSelect={maxSelect}
      />
    </>
  )
}

// ── Picker Dialog ──────────────────────────────────────────────────────────

interface SeedPickerDialogProps {
  open: boolean
  onClose: () => void
  initialSelected: ImageRecord[]
  onConfirm: (imgs: ImageRecord[]) => void
  maxSelect?: number
}

function SeedPickerDialog({ open, onClose, initialSelected, onConfirm, maxSelect }: SeedPickerDialogProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const [selected, setSelected] = useState<Map<string, ImageRecord>>(
    () => new Map(initialSelected.map((it) => [it.id, it]))
  )
  const [folder, setFolder] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sourceType, setSourceType] = useState<'all' | 'original' | 'generated'>('all')
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null)

  // Reset selection when dialog re-opens
  useState(() => {
    if (open) {
      setSelected(new Map(initialSelected.map((it) => [it.id, it])))
    }
  })

  const { data, fetchNextPage, hasNextPage, isLoading, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['seed-picker', projectId, folder, search, sourceType],
    queryFn: ({ pageParam = 0 }) => {
      if (!projectId) return Promise.resolve({ items: [], total: 0 })
      return api.images.list({
        project_id: projectId,
        offset: pageParam as number,
        limit: PAGE_SIZE,
        search: search || undefined,
        source_type: sourceType !== 'all' ? sourceType : undefined,
        ...(folder === '' ? { folder: '' } : folder ? { folder_prefix: folder } : {}),
        status: 'passed',
      })
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.items.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    initialPageParam: 0,
    enabled: open && !!projectId,
  })

  const allImages = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data])
  const total = data?.pages[0]?.total ?? 0
  const allSelectedInView = allImages.length > 0 && allImages.every((img) => selected.has(img.id))

  const toggleOne = (img: ImageRecord, idx: number, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedIdx !== null && lastClickedIdx !== idx) {
      // Range select between lastClickedIdx and idx
      const [from, to] = lastClickedIdx < idx ? [lastClickedIdx, idx] : [idx, lastClickedIdx]
      const next = new Map(selected)
      const targetState = !selected.has(img.id)
      for (let i = from; i <= to; i++) {
        const item = allImages[i]
        if (!item) continue
        if (targetState) {
          if (!maxSelect || next.size < maxSelect) next.set(item.id, item)
        } else {
          next.delete(item.id)
        }
      }
      setSelected(next)
    } else {
      const next = new Map(selected)
      if (next.has(img.id)) next.delete(img.id)
      else if (!maxSelect || next.size < maxSelect) next.set(img.id, img)
      setSelected(next)
    }
    setLastClickedIdx(idx)
  }

  const toggleAllInView = () => {
    const next = new Map(selected)
    if (allSelectedInView) {
      allImages.forEach((img) => next.delete(img.id))
    } else {
      for (const img of allImages) {
        if (maxSelect && next.size >= maxSelect) break
        next.set(img.id, img)
      }
    }
    setSelected(next)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl h-[80vh] p-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-5 py-3 border-b border-foreground/5">
          <DialogTitle className="text-[14px] font-medium">选择种子图</DialogTitle>
        </DialogHeader>

        {/* Body: 2-column layout */}
        <div className="flex-1 min-h-0 flex">
          {/* Folder tree */}
          <aside className="w-52 shrink-0 border-r border-foreground/5 overflow-y-auto px-2 py-3">
            <h4 className="text-[10px] font-medium text-foreground/45 mb-1.5 px-1.5">文件夹</h4>
            {projectId && (
              <FolderTree
                projectId={projectId}
                selected={folder}
                onSelect={(p) => setFolder(p)}
              />
            )}
          </aside>

          {/* Grid + filter */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-foreground/5">
              <div className="relative flex-1 max-w-sm">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-foreground/35" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="按文件名搜索"
                  className="h-7 pl-7 text-[12px]"
                />
              </div>
              <select
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as any)}
                className="h-7 rounded-md border border-foreground/15 bg-background px-2 text-[11px]"
              >
                <option value="all">全部来源</option>
                <option value="original">仅原图</option>
                <option value="generated">仅 AI 生成</option>
              </select>
              <Button
                variant="ghost" size="sm" className="h-7 text-[11px]"
                onClick={toggleAllInView}
                disabled={allImages.length === 0}
              >
                {allSelectedInView ? '全不选' : `全选当前 (${allImages.length})`}
              </Button>
              <span className="ml-auto text-[11px] text-foreground/45 tabular-nums">
                共 {total.toLocaleString()} · 已选 {selected.size}{maxSelect ? ` / ${maxSelect}` : ''}
              </span>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {isLoading ? (
                <div className="grid grid-cols-6 gap-3">
                  {Array.from({ length: 18 }).map((_, i) => (
                    <div key={i} className="aspect-square rounded-md bg-foreground/[0.04] animate-pulse" />
                  ))}
                </div>
              ) : allImages.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-[12px] text-foreground/40">
                  当前筛选下没有图片
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-6 gap-3">
                    {allImages.map((img, idx) => {
                      const isSel = selected.has(img.id)
                      return (
                        <button
                          key={img.id}
                          onClick={(e) => toggleOne(img, idx, e)}
                          className={cn(
                            'relative rounded-md overflow-hidden bg-foreground/[0.04] transition-all',
                            'ring-1 ring-transparent hover:ring-foreground/15',
                            isSel && 'ring-2 ring-accent',
                          )}
                          title={`${img.file_name}${img.relative_dir ? ` · ${img.relative_dir}` : ''}`}
                        >
                          <ThumbnailImage
                            imageId={img.id}
                            size={300}
                            version={img.updated_at}
                            className="aspect-square"
                          />
                          {isSel && (
                            <div className="absolute top-1 left-1 w-5 h-5 rounded-sm bg-accent text-white flex items-center justify-center">
                              <Check size={12} strokeWidth={3} />
                            </div>
                          )}
                          {img.source_type === 'generated' && (
                            <Badge
                              variant="secondary"
                              className="absolute top-1 right-1 text-[8px] px-1 py-0 bg-info/30 text-white border-info/40 backdrop-blur"
                            >
                              <Sparkles size={8} className="mr-0.5" /> AI
                            </Badge>
                          )}
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent p-1">
                            <p className="text-[9px] text-white/90 truncate">{img.file_name}</p>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  {hasNextPage && (
                    <div className="text-center mt-4">
                      <Button
                        variant="ghost" size="sm" className="text-[11px]"
                        disabled={isFetchingNextPage}
                        onClick={() => fetchNextPage()}
                      >
                        {isFetchingNextPage ? '加载中…' : '加载更多'}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-foreground/5 flex items-center justify-between gap-3">
          <span className="text-[12px] text-foreground/55">
            提示：<kbd className="px-1 py-0.5 rounded bg-foreground/10 text-foreground/65 mx-1">Shift</kbd>+点击 范围选；
            支持按文件夹与来源筛选
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={() => onConfirm(Array.from(selected.values()))}>
              确定 ({selected.size})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
