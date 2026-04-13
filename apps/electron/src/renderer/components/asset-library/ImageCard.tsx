import { ThumbnailImage } from './ThumbnailImage'
import { Badge } from '@/components/ui/badge'
import type { ImageRecord } from '@/lib/types'

interface ImageCardProps {
  image: ImageRecord
  onClick: () => void
}

export function ImageCard({ image, onClick }: ImageCardProps) {
  return (
    <div className="relative group">
      <ThumbnailImage
        imageId={image.id}
        alt={image.file_name}
        size={300}
        className="aspect-square"
        onClick={onClick}
      />

      {/* Status badge */}
      {image.quality_status === 'rejected' && (
        <Badge variant="destructive" className="absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0">
          淘汰
        </Badge>
      )}
      {image.tag_status === 'tagged' && (
        <Badge variant="secondary" className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0">
          已打标
        </Badge>
      )}

      {/* Hover overlay with file name */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-[11px] text-white truncate">{image.file_name}</p>
      </div>
    </div>
  )
}
