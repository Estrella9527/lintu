import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { DetailDrawer } from '@/components/shared/DetailDrawer'
import { ThumbnailImage } from './ThumbnailImage'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { ImageRecord } from '@/lib/types'

interface ImageDetailDrawerProps {
  image: ImageRecord | null
  open: boolean
  onClose: () => void
}

export function ImageDetailDrawer({ image, open, onClose }: ImageDetailDrawerProps) {
  // Fetch full detail with tags
  const { data: detail } = useQuery({
    queryKey: ['image-detail', image?.id],
    queryFn: () => api.images.get(image!.id),
    enabled: !!image && open,
  })

  if (!image) return null

  const img = detail || image

  return (
    <DetailDrawer open={open} onClose={onClose} title={img.file_name}>
      <div className="space-y-5">
        {/* Large preview */}
        <ThumbnailImage imageId={img.id} size={800} className="w-full aspect-video" />

        {/* File info */}
        <section>
          <h3 className="text-[13px] font-medium text-foreground/80 mb-2">文件信息</h3>
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-[12px]">
            <InfoRow label="分辨率" value={img.width && img.height ? `${img.width}×${img.height}` : '—'} />
            <InfoRow label="大小" value={img.file_size_kb ? `${img.file_size_kb} KB` : '—'} />
            <InfoRow label="清晰度" value={img.blur_score != null ? img.blur_score.toFixed(1) : '—'} />
            <InfoRow label="亮度" value={img.brightness != null ? img.brightness.toFixed(1) : '—'} />
            <InfoRow label="质检状态" value={
              img.quality_status === 'passed' ? '✓ 通过' :
              img.quality_status === 'rejected' ? `✗ 淘汰 (${img.reject_reason || ''})` : '待检'
            } />
            <InfoRow label="打标状态" value={
              img.tag_status === 'tagged' ? '✓ 已打标' : img.tag_status === 'manual' ? '手动' : '待打标'
            } />
          </div>
        </section>

        <Separator />

        {/* Tags */}
        {detail?.tags && detail.tags.length > 0 && (
          <section>
            <h3 className="text-[13px] font-medium text-foreground/80 mb-2">标签</h3>
            <div className="space-y-2">
              {Object.entries(groupTagsByDimension(detail.tags)).map(([dim, values]) => (
                <div key={dim} className="flex items-start gap-2">
                  <span className="text-[11px] text-foreground/40 w-14 shrink-0 pt-0.5">{dim}</span>
                  <div className="flex flex-wrap gap-1">
                    {values.map((v) => (
                      <Badge key={v} variant="secondary" className="text-[11px] px-1.5 py-0">
                        {v}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* AI Description */}
        {img.description && (
          <>
            <Separator />
            <section>
              <h3 className="text-[13px] font-medium text-foreground/80 mb-2">AI 描述</h3>
              <p className="text-[13px] text-foreground/60">{img.description}</p>
            </section>
          </>
        )}
      </div>
    </DetailDrawer>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-foreground/40">{label}</span>
      <span className="text-foreground/70">{value}</span>
    </>
  )
}

function groupTagsByDimension(tags: Array<{ dimension: string; value: string }>) {
  const groups: Record<string, string[]> = {}
  for (const t of tags) {
    if (!groups[t.dimension]) groups[t.dimension] = []
    groups[t.dimension].push(t.value)
  }
  return groups
}
