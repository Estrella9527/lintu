import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ImageCard } from './ImageCard'
import type { ImageRecord } from '@/lib/types'

interface JustifiedGridProps {
  images: ImageRecord[]
  /** Target row height in px. Final row heights may shrink slightly when the
   * row's natural width exceeds the container. */
  targetRowHeight?: number
  /** Gap between thumbnails in a row, and between rows. */
  gap?: number
  /** Cap on per-image width (avoid one panoramic photo eating the whole row). */
  maxImageWidth?: number

  selectedIds: Set<string>
  activeId?: string | null
  selectionMode: boolean
  onClickImage: (img: ImageRecord, list: ImageRecord[]) => void
  onDoubleClickImage?: (img: ImageRecord, list: ImageRecord[]) => void
  onToggleSelect: (id: string) => void
}

interface RowItem {
  image: ImageRecord
  width: number
  aspect: number
}

interface Row {
  items: RowItem[]
  height: number
}

const DEFAULT_TARGET_HEIGHT = 200
const DEFAULT_GAP = 8
const DEFAULT_MAX_IMAGE_WIDTH = 600

/** Eagle-style justified rows.
 *
 * Walks images left-to-right; each row accumulates aspect-ratios until the
 * scaled total width hits the container width, then we recompute the exact
 * row height that fits perfectly. Final row keeps target height (no stretch).
 */
function buildRows(
  images: ImageRecord[],
  containerWidth: number,
  targetHeight: number,
  gap: number,
  maxImageWidth: number,
): Row[] {
  if (containerWidth <= 0 || images.length === 0) return []

  const rows: Row[] = []
  let current: { image: ImageRecord; aspect: number }[] = []
  let aspectSum = 0

  const finalize = (height: number) => {
    if (current.length === 0) return
    rows.push({
      items: current.map(({ image, aspect }) => ({
        image,
        aspect,
        width: Math.min(maxImageWidth, aspect * height),
      })),
      height,
    })
    current = []
    aspectSum = 0
  }

  for (const img of images) {
    let aspect: number
    if (img.width && img.height && img.width > 0 && img.height > 0) {
      aspect = img.width / img.height
    } else {
      aspect = 1
    }
    // Cap extreme panoramas so they don't break the row geometry
    aspect = Math.max(0.4, Math.min(aspect, maxImageWidth / targetHeight))

    current.push({ image: img, aspect })
    aspectSum += aspect

    const naturalWidth = aspectSum * targetHeight + (current.length - 1) * gap
    if (naturalWidth >= containerWidth) {
      // Solve for exact height that makes the row fit
      const available = containerWidth - (current.length - 1) * gap
      const exactHeight = available / aspectSum
      // Don't go too tall when only one fat image fills the row
      const cappedHeight = Math.min(exactHeight, targetHeight * 1.6)
      finalize(cappedHeight)
    }
  }
  // Last row: keep target height
  finalize(targetHeight)
  return rows
}


export function JustifiedGrid({
  images,
  targetRowHeight = DEFAULT_TARGET_HEIGHT,
  gap = DEFAULT_GAP,
  maxImageWidth = DEFAULT_MAX_IMAGE_WIDTH,
  selectedIds, activeId, selectionMode,
  onClickImage, onDoubleClickImage, onToggleSelect,
}: JustifiedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Track container width with ResizeObserver — fires for both window resize
  // and sidebar collapse, so the rows reflow naturally.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rows = useMemo(
    () => buildRows(images, containerWidth, targetRowHeight, gap, maxImageWidth),
    [images, containerWidth, targetRowHeight, gap, maxImageWidth],
  )

  return (
    <div ref={containerRef} className="w-full">
      {rows.map((row, rIdx) => (
        <div
          key={rIdx}
          className="flex"
          style={{
            gap: `${gap}px`,
            marginBottom: rIdx === rows.length - 1 ? 0 : `${gap}px`,
            height: row.height,
          }}
        >
          {row.items.map(({ image, width }) => (
            <div
              key={image.id}
              style={{ width: `${width}px`, flexShrink: 0 }}
              className="relative"
            >
              <ImageCard
                image={image}
                selected={selectedIds.has(image.id)}
                active={activeId === image.id}
                selectionMode={selectionMode}
                aspect="natural"
                onClick={() => onClickImage(image, images)}
                onDoubleClick={() => onDoubleClickImage?.(image, images)}
                onToggleSelect={() => onToggleSelect(image.id)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
