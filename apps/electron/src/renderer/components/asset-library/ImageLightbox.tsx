import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight, Folder, Info, Maximize2, Minus, Plus, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import type { ImageRecord } from '@/lib/types'

const API_BASE = 'http://127.0.0.1:7879'

interface SimilarMatch {
  image_id: string
  rank: number
  score: number
  embedding_sim: number
  url: string | null
  thumbnail_url: string | null
  file_name: string
  source_type: string | null
}

interface ImageLightboxProps {
  images: ImageRecord[]
  initialIndex: number
  open: boolean
  onClose: () => void
  /** Open the side detail drawer for the current image. */
  onShowDetails?: (image: ImageRecord) => void
}

// Zoom limits — 1 = fit to viewport, up to 8x
const ZOOM_MIN = 1
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25       // each wheel notch / button click

export function ImageLightbox({
  images, initialIndex, open, onClose, onShowDetails,
}: ImageLightboxProps) {
  const [index, setIndex] = useState(initialIndex)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null)

  // Has the full-resolution image for the current index finished loading?
  // Drives the blur-up: thumbnail is visible until the full file lands.
  const [fullLoaded, setFullLoaded] = useState(false)

  // Find-similar side panel state.
  const [similarOpen, setSimilarOpen] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarSeedId, setSimilarSeedId] = useState<string | null>(null)
  const [similarResults, setSimilarResults] = useState<SimilarMatch[]>([])
  const [similarError, setSimilarError] = useState<string | null>(null)

  // Sync when caller jumps to a new image; reset zoom/pan
  useEffect(() => {
    if (open) {
      setIndex(initialIndex)
      setZoom(1)
      setPan({ x: 0, y: 0 })
      setFullLoaded(false)
    }
  }, [open, initialIndex])

  // Reset similar panel when lightbox closes
  useEffect(() => {
    if (!open) {
      setSimilarOpen(false)
      setSimilarResults([])
      setSimilarSeedId(null)
      setSimilarError(null)
    }
  }, [open])

  const total = images.length
  const safeIndex = Math.min(Math.max(0, index), Math.max(0, total - 1))
  const current = images[safeIndex]

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const fetchSimilar = useCallback(async (seedId: string) => {
    setSimilarLoading(true)
    setSimilarError(null)
    try {
      const res = await fetch(`${API_BASE}/open-api/v1/images/similar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed_image_id: seedId, limit: 12, diversity: 'balanced' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any)?.detail?.message || (err as any)?.error?.message || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setSimilarResults(Array.isArray(data?.matches) ? data.matches : [])
      setSimilarSeedId(seedId)
    } catch (e) {
      setSimilarError((e as Error).message)
      setSimilarResults([])
    } finally {
      setSimilarLoading(false)
    }
  }, [])

  const toggleSimilar = useCallback(() => {
    if (!current) return
    if (similarOpen && similarSeedId === current.id) {
      setSimilarOpen(false)
      return
    }
    setSimilarOpen(true)
    if (similarSeedId !== current.id) fetchSimilar(current.id)
  }, [current, similarOpen, similarSeedId, fetchSimilar])

  const onClickSimilarResult = useCallback((m: SimilarMatch) => {
    const idx = images.findIndex((it) => it.id === m.image_id)
    if (idx >= 0) {
      setIndex(idx)
      resetView()
      setFullLoaded(false)
    } else if (m.url) {
      window.open(m.url, '_blank')
    }
  }, [images, resetView])

  const goPrev = useCallback(() => {
    if (total === 0) return
    setIndex((i) => (i - 1 + total) % total)
    resetView()
    setFullLoaded(false)
  }, [total, resetView])

  const goNext = useCallback(() => {
    if (total === 0) return
    setIndex((i) => (i + 1) % total)
    resetView()
    setFullLoaded(false)
  }, [total, resetView])

  const zoomIn = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP)), [])
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(ZOOM_MIN, z / ZOOM_STEP)
      if (next === ZOOM_MIN) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  // Keyboard navigation — only while open. Capture so it works even when
  // focus is on a button. Space (and other handled keys) always
  // preventDefault — including key-repeat events — so holding the key
  // can't fall through to browser defaults like page scroll. Actions
  // themselves only fire on the initial press.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      const handled =
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'Escape' || e.code === 'Space' ||
        e.key === '+' || e.key === '=' ||
        e.key === '-' || e.key === '_' ||
        e.key === '0'
      if (!handled) return
      e.preventDefault()
      if (e.repeat) return
      if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'Escape' || e.code === 'Space') onClose()
      else if (e.key === '+' || e.key === '=') zoomIn()
      else if (e.key === '-' || e.key === '_') zoomOut()
      else if (e.key === '0') resetView()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, goPrev, goNext, onClose, zoomIn, zoomOut, resetView])

  // Wheel zoom — anchor to current cursor location for natural feel
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
    setZoom((z) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor))
      if (next === ZOOM_MIN) setPan({ x: 0, y: 0 })
      return next
    })
  }

  // Drag to pan when zoomed
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (zoom <= 1) return
    e.preventDefault()
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startPanX: pan.x, startPanY: pan.y,
    }
  }
  useEffect(() => {
    if (!open) return
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      setPan({ x: d.startPanX + (e.clientX - d.startX), y: d.startPanY + (e.clientY - d.startY) })
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [open])

  // Preload neighbor full-res images so flipping feels snappy. Thumbnails for
  // neighbors are already in the grid cache from the asset library, so we
  // only warm the heavier /file fetch here.
  const neighborSrcs = useMemo(() => {
    if (!current || total === 0) return []
    const idxs = [(safeIndex - 1 + total) % total, (safeIndex + 1) % total]
    return idxs
      .filter((i) => i !== safeIndex)
      .map((i) => fullUrl(images[i]))
  }, [images, safeIndex, total, current])

  if (!open || !current) return null

  const overlay = (
    <div
      className="fixed inset-0 z-[80] bg-black/95 flex flex-col select-none"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="flex items-center gap-3 px-4 h-12 shrink-0 text-white/85"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[12px] tabular-nums text-white/60">
          {safeIndex + 1} / {total}
        </span>
        <span className="text-[13px] font-medium truncate flex-1">
          {current.file_name}
        </span>
        {current.relative_dir && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-white/10 text-white/70 border-white/10">
            <Folder size={10} className="mr-1" />
            {current.relative_dir}
          </Badge>
        )}
        {current.source_type === 'generated' && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-info/30 text-white border-info/40">
            AI 生成
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 text-[12px] hover:bg-white/10',
            similarOpen ? 'text-white bg-white/10' : 'text-white/80 hover:text-white',
          )}
          onClick={toggleSimilar}
          title="基于嵌入向量找视觉相似图"
        >
          <Search size={13} className="mr-1" /> 找相似
        </Button>
        {onShowDetails && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[12px] text-white/80 hover:text-white hover:bg-white/10"
            onClick={() => onShowDetails(current)}
          >
            <Info size={13} className="mr-1" /> 详情
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-white/70 hover:text-white hover:bg-white/10"
          onClick={onClose}
          title="关闭 (Esc)"
        >
          <X size={16} />
        </Button>
      </div>

      {/* Image stage */}
      <div
        className="flex-1 min-h-0 relative flex items-center justify-center px-4 pb-3 overflow-hidden"
        onClick={(e) => {
          // Click on backdrop closes; click on image is absorbed below
          if (e.target === e.currentTarget && zoom <= 1) onClose()
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        style={{ cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default' }}
      >
        {/* Blur-up stage: fills the viewport slot so both images share the
           same object-contain frame (same aspect ratio math), keeping the
           blur-up placeholder in pixel-perfect alignment with the full
           original as it fades in. */}
        <div
          className="relative w-full h-full"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => { e.stopPropagation(); zoom > 1 ? resetView() : setZoom(2) }}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: dragRef.current ? 'none' : 'transform 80ms ease-out',
          }}
        >
          {!fullLoaded && (
            <img
              key={`thumb-${current.id}`}
              src={thumbUrl(current)}
              alt=""
              draggable={false}
              className="absolute inset-0 w-full h-full object-contain rounded-sm filter blur-sm"
              aria-hidden
            />
          )}
          <img
            key={`full-${current.id}`}
            src={fullUrl(current)}
            alt={current.file_name}
            draggable={false}
            onLoad={() => setFullLoaded(true)}
            onError={() => setFullLoaded(true)}
            className={cn(
              'absolute inset-0 w-full h-full object-contain shadow-2xl rounded-sm bg-black/40 select-none',
              'transition-opacity duration-150',
              fullLoaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        </div>

        {/* Prev / Next overlays — hide while zoomed so they don't get in the way */}
        {total > 1 && zoom <= 1 && (
          <>
            <NavButton side="left" onClick={(e) => { e.stopPropagation(); goPrev() }} />
            <NavButton side="right" onClick={(e) => { e.stopPropagation(); goNext() }} />
          </>
        )}

        {/* Zoom toolbar (bottom-center) */}
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-white/8 backdrop-blur text-white/80"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="h-7 w-7 rounded-full hover:bg-white/15 flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
            title="缩小 (-)"
          >
            <Minus size={14} />
          </button>
          <span className="text-[11px] tabular-nums w-10 text-center text-white/85">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="h-7 w-7 rounded-full hover:bg-white/15 flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
            title="放大 (+)"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={resetView}
            disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
            className="h-7 w-7 rounded-full hover:bg-white/15 flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent"
            title="重置 (0)"
          >
            <Maximize2 size={12} />
          </button>
        </div>

        {/* Hidden preloads */}
        <div className="hidden">
          {neighborSrcs.map((src) => (
            <img key={src} src={src} alt="" />
          ))}
        </div>
      </div>

      {/* Find-similar side panel */}
      {similarOpen && (
        <div
          className="absolute top-12 right-0 bottom-9 w-[280px] bg-black/90 border-l border-white/10 flex flex-col text-white"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 h-9 shrink-0 flex items-center justify-between border-b border-white/10">
            <div className="text-[12px] text-white/80 flex items-center gap-1.5">
              <Search size={12} className="text-white/55" />
              视觉相似 (Top {Math.max(0, similarResults.length)})
            </div>
            <button
              className="h-6 w-6 rounded hover:bg-white/10 text-white/55 hover:text-white flex items-center justify-center"
              onClick={() => setSimilarOpen(false)}
              title="关闭"
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {similarLoading ? (
              <div className="text-[11px] text-white/45 text-center py-6">加载中…</div>
            ) : similarError ? (
              <div className="text-[11px] text-destructive text-center py-6 px-2">
                {similarError}
                <div className="text-white/35 mt-1 text-[10px]">该图可能未生成 embedding，先到「Pipeline → 向量化」补齐</div>
              </div>
            ) : similarResults.length === 0 ? (
              <div className="text-[11px] text-white/45 text-center py-6">没有相似结果</div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {similarResults.map((m) => {
                  const inList = images.some((it) => it.id === m.image_id)
                  return (
                    <button
                      key={m.image_id}
                      onClick={() => onClickSimilarResult(m)}
                      className="group relative rounded overflow-hidden bg-white/5 hover:ring-1 hover:ring-white/40 transition"
                      title={inList ? '在当前列表中，点击切换' : '不在当前列表，点击在新窗口打开'}
                    >
                      {m.thumbnail_url ? (
                        <img
                          src={m.thumbnail_url}
                          alt={m.file_name}
                          loading="lazy"
                          className="w-full h-24 object-cover"
                        />
                      ) : (
                        <div className="w-full h-24 flex items-center justify-center text-[10px] text-white/30">无缩略图</div>
                      )}
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.5 rounded bg-black/65 text-[9px] tabular-nums text-white/85">
                        {(m.embedding_sim * 100).toFixed(0)}%
                      </div>
                      {!inList && (
                        <div className="absolute top-0.5 right-0.5 px-1 py-0.5 rounded bg-warning/70 text-[9px] text-white/95">
                          外
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 px-1 py-0.5 bg-gradient-to-t from-black/80 to-transparent text-[9px] text-white/80 truncate">
                        {m.file_name}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="px-3 py-1.5 border-t border-white/10 text-[10px] text-white/35">
            基于 embedding 余弦相似度 · 「外」= 不在当前列表
          </div>
        </div>
      )}

      {/* Bottom hint bar */}
      <div
        className="px-4 h-9 shrink-0 flex items-center justify-center gap-4 text-[10px] text-white/40"
        onClick={(e) => e.stopPropagation()}
      >
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 text-white/65 mr-1">←</kbd>/<kbd className="px-1 py-0.5 rounded bg-white/10 text-white/65 mx-1">→</kbd>切换</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 text-white/65 mr-1">滚轮</kbd>缩放</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 text-white/65 mr-1">双击</kbd>放大/复位</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 text-white/65 mr-1">Esc</kbd>关闭</span>
        {current.width && current.height && (
          <span className="ml-auto tabular-nums">{current.width}×{current.height}</span>
        )}
        {current.file_size_kb != null && (
          <span className="tabular-nums">{(current.file_size_kb / 1024).toFixed(1)} MB</span>
        )}
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick: (e: React.MouseEvent) => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      onClick={onClick}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 z-10',
        'h-12 w-12 rounded-full bg-white/8 backdrop-blur',
        'text-white/70 hover:text-white hover:bg-white/15',
        'flex items-center justify-center transition-colors',
        side === 'left' ? 'left-4' : 'right-4',
      )}
      title={side === 'left' ? '上一张 (←)' : '下一张 (→)'}
    >
      <Icon size={26} />
    </button>
  )
}

/** 800px cached thumbnail — used as a blur-up placeholder only. */
function thumbUrl(img: ImageRecord): string {
  const v = img.updated_at ? `&v=${encodeURIComponent(img.updated_at)}` : ''
  return api.images.thumbnailUrl(img.id, 800) + v
}

/** Full-resolution original bytes — zero re-encoding. This is what the user
 * must actually see, not a downsampled/compressed preview. */
function fullUrl(img: ImageRecord): string {
  const v = img.updated_at ? `&v=${encodeURIComponent(img.updated_at)}` : ''
  return api.images.fileUrl(img.id) + v
}
