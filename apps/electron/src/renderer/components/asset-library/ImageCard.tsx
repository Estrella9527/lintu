import { ThumbnailImage } from './ThumbnailImage'
import { Badge } from '@/components/ui/badge'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImageRecord } from '@/lib/types'

interface ImageCardProps {
  image: ImageRecord
  selected?: boolean
  selectionMode?: boolean
  onClick: () => void
  onToggleSelect?: () => void
}

export function ImageCard({ image, selected, selectionMode, onClick, onToggleSelect }: ImageCardProps) {
  const handleClick = (e: React.MouseEvent) => {
    if (selectionMode && onToggleSelect) {
      e.stopPropagation()
      onToggleSelect()
    } else {
      onClick()
    }
  }

  return (
    <div
      className={cn('relative group cursor-pointer', selected && 'ring-2 ring-accent rounded-md')}
      onClick={handleClick}
    >
      <ThumbnailImage
        imageId={image.id}
        alt={image.file_name}
        size={300}
        className="aspect-square"
      />

      {/* Selection checkbox */}
      <button
        className={cn(
          'absolute top-1.5 left-1.5 w-5 h-5 rounded-sm border transition-all flex items-center justify-center',
          selected
            ? 'bg-accent border-accent text-white'
            : 'border-white/60 bg-black/20 opacity-0 group-hover:opacity-100',
        )}
        onClick={(e) => { e.stopPropagation(); onToggleSelect?.() }}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </button>

      {/* Status badges */}
      {image.quality_status === 'rejected' && (
        <Badge variant="destructive" className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0">
          淘汰
        </Badge>
      )}
      {image.quality_status !== 'rejected' && image.tag_status === 'tagged' && (
        <Badge variant="secondary" className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0">
          已打标
        </Badge>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-[11px] text-white truncate">{image.file_name}</p>
      </div>
    </div>
  )
}
