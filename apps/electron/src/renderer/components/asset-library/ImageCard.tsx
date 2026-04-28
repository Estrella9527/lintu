import { ThumbnailImage } from './ThumbnailImage'
import { Badge } from '@/components/ui/badge'
import { Check, Folder, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImageRecord } from '@/lib/types'

interface ImageCardProps {
  image: ImageRecord
  selected?: boolean
  /** Active = the inspector panel is currently showing this image */
  active?: boolean
  selectionMode?: boolean
  /** "square" (default) crops to 1:1; "natural" fills the parent's box and
   * preserves aspect ratio — used by the justified row grid. */
  aspect?: 'square' | 'natural'
  onClick: () => void
  onDoubleClick?: () => void
  onToggleSelect?: () => void
}

export function ImageCard({ image, selected, active, selectionMode, aspect = 'square', onClick, onDoubleClick, onToggleSelect }: ImageCardProps) {
  const handleClick = (e: React.MouseEvent) => {
    if (selectionMode && onToggleSelect) {
      e.stopPropagation()
      onToggleSelect()
    } else {
      onClick()
    }
  }

  const isNatural = aspect === 'natural'

  return (
    <div className={cn('group cursor-pointer flex flex-col gap-1.5', isNatural && 'h-full')}>
      {/* Thumbnail */}
      <div
        className={cn(
          'relative rounded-md overflow-hidden bg-foreground/[0.04] transition-all',
          'ring-1 ring-transparent hover:ring-foreground/15',
          selected && 'ring-2 ring-accent',
          active && !selected && 'ring-2 ring-info/70',
          isNatural && 'flex-1 min-h-0',
        )}
        onClick={handleClick}
        onDoubleClick={onDoubleClick}
      >
        <ThumbnailImage
          imageId={image.id}
          alt={image.file_name}
          size={300}
          version={image.updated_at}
          className={isNatural ? 'w-full h-full' : 'aspect-square'}
        />

        {/* Selection checkbox */}
        <button
          className={cn(
            'absolute top-1.5 left-1.5 w-5 h-5 rounded-sm border transition-all flex items-center justify-center',
            selected
              ? 'bg-accent border-accent text-white'
              : 'border-white/60 bg-black/30 opacity-0 group-hover:opacity-100',
          )}
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.() }}
          title={selected ? '取消选中' : '加入选择'}
        >
          {selected && <Check size={12} strokeWidth={3} />}
        </button>

        {/* AI generated marker */}
        {image.source_type === 'generated' && (
          <Badge variant="secondary" className="absolute top-1.5 right-1.5 text-[9px] px-1 py-0 bg-info/30 text-white border-info/40 backdrop-blur">
            <Sparkles size={9} className="mr-0.5" /> AI
          </Badge>
        )}
        {image.quality_status === 'rejected' && (
          <Badge variant="destructive" className="absolute top-1.5 right-1.5 text-[9px] px-1 py-0">
            淘汰
          </Badge>
        )}

        {/* Hover overlay with filename — used in natural mode where there's
            no permanent caption below. */}
        {isNatural && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-2 pb-1.5 pt-6 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-[10px] text-white truncate leading-tight" title={image.file_name}>
              {image.file_name}
            </p>
            <p className="text-[9px] text-white/65 tabular-nums leading-tight">
              {image.width && image.height ? `${image.width} × ${image.height}` : ''}
              {image.relative_dir ? (
                <span className="ml-1.5 inline-flex items-center gap-0.5">
                  <Folder size={8} />
                  {foldershortLabel(image.relative_dir)}
                </span>
              ) : null}
            </p>
          </div>
        )}
      </div>

      {/* Persistent caption — only square mode (legacy callers) */}
      {!isNatural && (
        <div className="px-0.5 leading-tight">
          <p className="text-[11px] text-foreground/80 truncate" title={image.file_name}>
            {image.file_name}
          </p>
          <p className="text-[10px] text-foreground/40 tabular-nums">
            {image.width && image.height ? `${image.width} × ${image.height}` : ''}
            {image.relative_dir ? (
              <span className="ml-1.5 inline-flex items-center gap-0.5">
                <Folder size={8} className="opacity-50" />
                {foldershortLabel(image.relative_dir)}
              </span>
            ) : null}
          </p>
        </div>
      )}
    </div>
  )
}

// Show only the leaf folder when nested: "【1】悬崖/航拍" → "航拍"
function foldershortLabel(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1]
}
