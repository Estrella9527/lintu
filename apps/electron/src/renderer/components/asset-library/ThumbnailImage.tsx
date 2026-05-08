import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ImageOff } from 'lucide-react'
import { api } from '@/lib/api'

interface ThumbnailImageProps {
  imageId: string
  alt?: string
  size?: 128 | 300 | 800
  className?: string
  onClick?: () => void
  /** Version tag (e.g. image.updated_at) — appended as ?v= to bust HTTP cache
   * when the underlying file changes (orient, re-encode, etc.). */
  version?: string | null
}

export function ThumbnailImage({ imageId, alt, size = 300, className, onClick, version }: ThumbnailImageProps) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  // api.images.thumbnailUrl 已经拼上 ?token=...，再追加 &v= 来 bust 浏览器缓存
  const v = version ? `&v=${encodeURIComponent(version)}` : ''
  const src = api.images.thumbnailUrl(imageId, size) + v

  return (
    <div
      className={cn(
        'relative bg-foreground/[0.03] rounded-md overflow-hidden',
        onClick && 'cursor-pointer hover:ring-1 hover:ring-accent/30 transition-all',
        className,
      )}
      onClick={onClick}
    >
      {!error && (
        <img
          src={src}
          alt={alt || ''}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setError(true)}
          className={cn(
            'w-full h-full object-cover transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {!loaded && !error && (
        <div className="absolute inset-0 animate-pulse bg-foreground/[0.04]" />
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-foreground/20">
          <ImageOff size={20} />
        </div>
      )}
    </div>
  )
}
