import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { assetLibraryNavRequestAtom } from '@/atoms/navigation'
import {
  assetLibraryActiveTabAtom,
  assetLibraryFilterAtom,
  assetLibrarySelectedFolderAtom,
} from '@/atoms/ui-state'
import { cn } from '@/lib/utils'
import { Cloud, Copy, GitFork, LayoutGrid, Loader2, Star, Trash2, Upload } from 'lucide-react'
import { ImageGrid } from '@/components/asset-library/ImageGrid'
import { OssLibraryTab } from '@/components/asset-library/OssLibraryTab'
import { FilterBar, EMPTY_FILTER } from '@/components/asset-library/FilterBar'
import { ImageInspector } from '@/components/asset-library/ImageInspector'
import { ImageLightbox } from '@/components/asset-library/ImageLightbox'
import { BatchActionBar } from '@/components/asset-library/BatchActionBar'
import { FolderTree } from '@/components/asset-library/FolderTree'
import { DuplicateGroupsTab } from '@/components/asset-library/DuplicateGroupsTab'
import { ImageDropOverlay } from '@/components/shared/ImageDropOverlay'
import { activeProjectIdAtom } from '@/atoms/project'
import { useImageDropPaste } from '@/hooks/useImageDropPaste'
import { useUploadImages } from '@/hooks/useUploadImages'
import type { ImageRecord } from '@/lib/types'

const TABS = [
  { id: 'all', label: '全部图片', icon: LayoutGrid },
  { id: 'oss', label: 'OSS 图库', icon: Cloud },
  { id: 'duplicates', label: '相似组', icon: Copy },
  { id: 'trash', label: '回收站', icon: Trash2 },
  // 衍生关系(图谱可视化)/ 收藏夹尚未实装,先从 Tab 隐藏,避免用户点进空白页。
  // 待功能落地后再加回(图标 GitFork / Star 已 import)。
]

export default function AssetLibrary() {
  const [activeTab, setActiveTab] = useAtom(assetLibraryActiveTabAtom)

  // 'match' tab was removed (moved to 匹配实验室). Self-heal a stale value
  // from this session's atom so the page doesn't render an empty branch.
  useEffect(() => {
    if (activeTab === 'match') setActiveTab('all')
  }, [activeTab, setActiveTab])

  // Allow sibling components (e.g. DuplicateGroupsTab's completion CTA) to
  // navigate to the Trash sub-tab without prop-drilling.
  useEffect(() => {
    const onOpenTrash = () => setActiveTab('trash')
    window.addEventListener('lintu:open-trash', onOpenTrash)
    return () => window.removeEventListener('lintu:open-trash', onOpenTrash)
  }, [])
  const [filter, setFilter] = useAtom(assetLibraryFilterAtom)

  // Apply cross-page deep-link request (set by TaskCenter / Pipeline / Drawer).
  // Once consumed we clear the atom so re-mount doesn't re-apply stale state.
  const [navRequest, setNavRequest] = useAtom(assetLibraryNavRequestAtom)
  useEffect(() => {
    if (!navRequest) return
    if (navRequest.tab) setActiveTab(navRequest.tab)
    setFilter((cur) => ({
      ...cur,
      ...(navRequest.status ? { status: navRequest.status } : {}),
      ...(navRequest.source ? { source: navRequest.source } : {}),
      ...(navRequest.promptId !== undefined ? {
        prompt_id: navRequest.promptId,
        prompt_label: navRequest.promptLabel || '',
      } : {}),
      ...(navRequest.parentId !== undefined ? {
        parent_id: navRequest.parentId,
        parent_label: navRequest.parentLabel || '',
      } : {}),
      ...(navRequest.tags ? { tags: { ...EMPTY_FILTER.tags, ...navRequest.tags } } : {}),
    }))
    if (navRequest.folderPrefix !== undefined) {
      setSelectedFolder(navRequest.folderPrefix || null)
    }
    setNavRequest(null)
  }, [navRequest, setNavRequest])
  const [activeImage, setActiveImage] = useState<ImageRecord | null>(null)
  const [activeList, setActiveList] = useState<ImageRecord[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedFolder, setSelectedFolder] = useAtom(assetLibrarySelectedFolderAtom)
  const [lightboxState, setLightboxState] = useState<{ open: boolean; images: ImageRecord[]; index: number }>({
    open: false, images: [], index: 0,
  })
  // Keep latest activeImage / activeList accessible from key handler without
  // re-binding the listener every render
  const activeImageRef = useRef<ImageRecord | null>(null)
  const activeListRef = useRef<ImageRecord[]>([])
  activeImageRef.current = activeImage
  activeListRef.current = activeList

  const projectId = useAtomValue(activeProjectIdAtom)

  // Eagle behavior:
  //   click            → updates inspector (right panel)
  //   double-click     → opens lightbox
  //   spacebar (focus) → opens lightbox for active image
  const handleClickImage = useCallback((img: ImageRecord, list?: ImageRecord[]) => {
    setActiveImage(img)
    if (list && list !== activeList) setActiveList(list)
  }, [activeList])

  const handleDoubleClickImage = useCallback((img: ImageRecord, list?: ImageRecord[]) => {
    const fullList = list && list.length > 0 ? list : activeList
    const idx = Math.max(0, fullList.findIndex((it) => it.id === img.id))
    setActiveImage(img)
    setActiveList(fullList)
    setLightboxState({ open: true, images: fullList, index: idx })
  }, [activeList])

  const openLightboxForActive = useCallback(() => {
    const img = activeImageRef.current
    const list = activeListRef.current
    if (!img || list.length === 0) return
    const idx = Math.max(0, list.findIndex((it) => it.id === img.id))
    setLightboxState({ open: true, images: list, index: idx })
  }, [])

  // Spacebar opens lightbox for whichever image is in the inspector. Space
  // is reserved for preview ONLY — we always preventDefault outside text
  // inputs (including key-repeat events while Space is held) so the browser
  // never falls back to its "scroll page by viewport" behavior. The action
  // (open/toggle) only fires on the first press, but the swallow happens
  // every tick.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return
      e.preventDefault()
      if (e.repeat) return
      if (lightboxState.open) return
      openLightboxForActive()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openLightboxForActive, lightboxState.open])

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleClearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const handleSelectAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const allSelected = ids.every((id) => prev.has(id))
      if (allSelected) return new Set()
      return new Set(ids)
    })
  }, [])

  const gridStatus = activeTab === 'trash' ? 'rejected' : (filter.status !== 'all' ? filter.status : undefined)

  const showWorkBench = activeTab === 'all' || activeTab === 'trash'

  // ── 拖拽 / 粘贴上传 ────────────────────────────────────────────────────
  // 整页接拖拽 + 文档级 paste,上传完去 invalidate images 缓存让 grid 自刷。
  // 仅在「全部图片」Tab 启用 — 回收站 / 相似组 / 衍生关系 这些聚合视图
  // 接受拖入图反而误导用户(图会落进 all 视图,不在当前 tab 显示)。
  const queryClient = useQueryClient()
  const dropZoneRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadEnabled = activeTab === 'all' && !!projectId
  const { upload, uploading } = useUploadImages({
    projectId,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['images', projectId] })
      // FolderTree 的 queryKey 是 ['image-folders', ...],之前误写成 'folders' →
      // 上传后文件夹数字不立刻刷新。修正 key,让数字实时更新。
      queryClient.invalidateQueries({ queryKey: ['image-folders', projectId] })
      queryClient.invalidateQueries({ queryKey: ['oss-status'] })
    },
  })
  const { isDragging } = useImageDropPaste({
    dropRef: dropZoneRef,
    enabled: uploadEnabled,
    onFiles: (files) => { void upload(files) },
  })

  return (
    <>
      <div ref={dropZoneRef} className="relative flex flex-col h-full">
        <ImageDropOverlay visible={isDragging && uploadEnabled} />
        {/* Header + tabs combined in single 40px row */}
        <div className="flex items-center gap-5 px-5 h-[40px] shrink-0 border-b border-foreground/5">
          <h1 className="text-[13px] font-semibold text-foreground/85 shrink-0">资产库</h1>
          <div className="flex gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id)
                    handleClearSelection()
                    // Trash has no folder tree — drop any folder filter so
                    // the trash grid doesn't accidentally stay scoped.
                    if (tab.id === 'trash') setSelectedFolder(null)
                  }}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] rounded-md transition-colors',
                    isActive
                      ? 'bg-accent/10 text-accent'
                      : 'text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                  )}
                >
                  <Icon size={13} strokeWidth={1.5} />
                  {tab.label}
                </button>
              )
            })}
          </div>
          {uploadEnabled && (
            <div className="ml-auto flex items-center gap-1">
              {/* 不用 `hidden` 属性 — Electron / Chromium 在 display:none 的
                  input 上调 .click() 偶尔会静默失败。改用 sr-only 定位 + 0 透明,
                  保留 input 在交互流里。 */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || [])
                  if (files.length) void upload(files)
                  if (fileInputRef.current) fileInputRef.current.value = ''
                }}
              />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  fileInputRef.current?.click()
                }}
                disabled={uploading}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-md transition-colors',
                  uploading
                    ? 'text-foreground/40 cursor-wait'
                    : 'text-foreground/65 hover:text-foreground hover:bg-foreground/[0.05]',
                )}
                title="选择本地图片上传 · 也可直接拖入页面 / Ctrl+V 粘贴截图"
              >
                {uploading
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Upload size={13} strokeWidth={1.5} />}
                <span>上传图片</span>
              </button>
            </div>
          )}
        </div>

        {/* 3-pane content (Eagle layout) */}
        <div className="flex-1 min-h-0 overflow-hidden flex">
          {showWorkBench ? (
            projectId ? (
              <>
                {/* Left: folder tree — only on "全部图片" tab.
                    Hidden on 回收站 because folder counts are whole-library
                    (not trash-scoped) and would mislead users; trash is a
                    flat review workspace. */}
                {activeTab === 'all' && (
                  <aside className="w-56 shrink-0 overflow-y-auto px-3 py-3 border-r border-foreground/5">
                    <h3 className="text-[11px] font-medium text-foreground/50 mb-2 px-1.5">按文件夹筛选</h3>
                    <FolderTree
                      projectId={projectId}
                      selected={selectedFolder}
                      onSelect={(p) => { setSelectedFolder(p); handleClearSelection() }}
                      inLibrary={true}
                    />
                  </aside>
                )}

                {/* Center: filter bar + grid. The toolbar (filter + batch
                    actions) is `sticky top-0` so it stays in view while the
                    grid scrolls — operations are always reachable, no matter
                    how far down the user has scrolled. */}
                <div className="flex-1 min-w-0 overflow-y-auto">
                  <div className="sticky top-0 z-20 bg-background px-5 pt-3 pb-2 border-b border-foreground/5">
                    {activeTab === 'all' && <FilterBar filter={filter} onChange={setFilter} />}
                    {activeTab === 'trash' && (
                      <div className="mb-2 rounded-lg border border-foreground/8 bg-foreground/[0.015] px-3 py-2 text-[11.5px] text-foreground/60 leading-relaxed">
                        这里是被标记为「淘汰」或被去重流程判定为副本的图片，<strong className="text-foreground/80">尚未从磁盘删除</strong>。
                        选中后可<strong className="text-success">恢复</strong>回全部图片，或确认无误后<strong className="text-destructive">永久删除</strong>。
                      </div>
                    )}
                    <BatchActionBar
                      selectedCount={selectedIds.size}
                      selectedIds={selectedIds}
                      onClear={handleClearSelection}
                      mode={activeTab === 'trash' ? 'trash' : 'library'}
                    />
                  </div>
                  <div className="px-5 pt-3 pb-3">
                    <ImageGrid
                      projectId={projectId}
                      search={activeTab === 'all' ? (filter.search || undefined) : undefined}
                      status={gridStatus}
                      sourceType={activeTab === 'all' ? (filter.source !== 'all' ? filter.source : undefined) : undefined}
                      folder={selectedFolder}
                      tagFilters={activeTab === 'all' ? filter.tags : undefined}
                      promptId={activeTab === 'all' ? (filter.prompt_id || undefined) : undefined}
                      parentId={activeTab === 'all' ? (filter.parent_id || undefined) : undefined}
                      // 「全部图片」只展示已入库的图;AI 工坊生成图/画布草稿不在此显示,
                      // 直到运营「加入资产库」。回收站不加此过滤(按淘汰态聚合)。
                      inLibrary={activeTab === 'all' ? true : undefined}
                      selectedIds={selectedIds}
                      activeId={activeImage?.id ?? null}
                      onToggleSelect={handleToggleSelect}
                      onSelectAll={handleSelectAll}
                      onClickImage={handleClickImage}
                      onDoubleClickImage={handleDoubleClickImage}
                    />
                  </div>
                </div>

                {/* Right: persistent inspector */}
                <ImageInspector
                  image={activeImage}
                  onPreview={(img) => {
                    const list = activeListRef.current
                    const idx = Math.max(0, list.findIndex((it) => it.id === img.id))
                    setLightboxState({ open: true, images: list.length ? list : [img], index: idx })
                  }}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[13px] text-foreground/30">
                请先在流水线中选择目录并扫描图片
              </div>
            )
          ) : activeTab === 'oss' ? (
            <OssLibraryTab projectId={projectId} />
          ) : activeTab === 'duplicates' ? (
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <DuplicateGroupsTab />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10 mx-6 my-4">
              {activeTab === 'derivatives' ? '图谱可视化（V3.0 预留）' : '收藏夹功能开发中'}
            </div>
          )}
        </div>
      </div>

      <ImageLightbox
        open={lightboxState.open}
        images={lightboxState.images}
        initialIndex={lightboxState.index}
        onClose={() => setLightboxState((s) => ({ ...s, open: false }))}
        // Eagle: pressing Esc / clicking 详情 returns focus to inspector — already
        // showing this image in the right panel
        onShowDetails={(img) => setActiveImage(img)}
      />
    </>
  )
}
