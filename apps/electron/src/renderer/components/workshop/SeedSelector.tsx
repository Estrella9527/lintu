import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'

import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { ImageLightbox } from '@/components/asset-library/ImageLightbox'
import { ImageDropOverlay } from '@/components/shared/ImageDropOverlay'
import { SeedPickerDialog } from '@/components/workshop/SeedPickerDialog'
import { cn } from '@/lib/utils'
import { Eye, FolderOpen, Loader2, Upload, X } from 'lucide-react'
import { useImageDropPaste } from '@/hooks/useImageDropPaste'
import { useUploadImages } from '@/hooks/useUploadImages'
import type { ImageRecord } from '@/lib/types'

interface SeedSelectorProps {
  selectedImages: ImageRecord[]
  onSelect: (images: ImageRecord[]) => void
  maxSelect?: number
}

export function SeedSelector({ selectedImages, onSelect, maxSelect }: SeedSelectorProps) {
  const [showPicker, setShowPicker] = useState(false)
  const [lightbox, setLightbox] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  // dropRef 只挂在「下面那个"种子图区"」上,不覆盖按钮行 —— 否则拖拽时
  // 按钮也会被罩住,用户在拖动过程中没法松手到按钮上,体验很怪。
  const dropRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 拖拽 / 粘贴 / 浏览本地 → 上传到当前项目 → 自动追加到 selectedImages。
  // remaining 让 maxSelect 的硬上限继续生效:如果剩余配额是 2,但用户拖了
  // 5 张图,我们仍上传 5 张(它们落到资产库不会丢),只是只把前 2 张选中,
  // 其他 3 张托管给"从资产库选择"的人工补选。
  const remaining = maxSelect == null ? Infinity : Math.max(0, maxSelect - selectedImages.length)
  const { upload, uploading } = useUploadImages({
    projectId,
    onSuccess: ({ images, duplicate_images }) => {
      // 把"新上传"和"已在资产库的同 hash 图"统一对待 — 用户拖图的本意是
      // "把这张图作为种子",不应该因为我们恰好已经存过它就让 UI 显示空白。
      const candidates = [...images, ...duplicate_images]
      if (!candidates.length) return
      queryClient.invalidateQueries({ queryKey: ['images', projectId] })
      queryClient.invalidateQueries({ queryKey: ['seed-picker', projectId] })
      const existingIds = new Set(selectedImages.map((i) => i.id))
      const fresh = candidates.filter((i) => !existingIds.has(i.id))
      const slotsLeft = maxSelect == null ? fresh.length : Math.max(0, maxSelect - selectedImages.length)
      const toAdd = fresh.slice(0, slotsLeft)
      if (toAdd.length) onSelect([...selectedImages, ...toAdd])
    },
  })
  const { isDragging } = useImageDropPaste({
    dropRef,
    enabled: !!projectId && remaining > 0,
    onFiles: (files) => { void upload(files) },
  })

  const removeOne = (id: string) => onSelect(selectedImages.filter((s) => s.id !== id))

  return (
    <>
      <div className="space-y-3">
        {/* 第一行:操作按钮(永远可点,不被 overlay 罩住) */}
        <div className="flex gap-2 items-center flex-wrap">
          <Button
            variant="outline" size="sm" className="text-[12px] h-8"
            onClick={() => setShowPicker(true)}
          >
            <FolderOpen size={13} className="mr-1.5" />
            从资产库选择 …
          </Button>
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
          <Button
            variant="outline" size="sm" className="text-[12px] h-8"
            disabled={uploading || !projectId || remaining === 0}
            onClick={() => fileInputRef.current?.click()}
            title="也可直接拖入下方框 / Ctrl+V 粘贴截图"
          >
            {uploading
              ? <Loader2 size={13} className="mr-1.5 animate-spin" />
              : <Upload size={13} className="mr-1.5" />}
            上传新图作为种子
          </Button>
          {selectedImages.length > 0 && (
            <Button
              variant="ghost" size="sm" className="text-[11px] h-8 text-foreground/40 ml-auto"
              onClick={() => onSelect([])}
            >
              清空 ({selectedImages.length})
            </Button>
          )}
        </div>

        {/* 第二行:种子图展示区 / 拖拽落点 */}
        <div
          ref={dropRef}
          className={cn(
            'relative rounded-lg border border-dashed border-foreground/12 bg-foreground/[0.015]',
            'min-h-[160px] p-3 transition-colors',
            isDragging && 'border-accent/45 bg-accent/[0.04]',
          )}
        >
          <ImageDropOverlay
            visible={isDragging}
            tone="accent"
            title="松手即可上传 + 自动作为种子图"
            subtitle={maxSelect
              ? `还可加入 ${remaining} 张 · 多余的图也会进资产库`
              : '将作为本次生成的种子图'}
          />
          {selectedImages.length > 0 ? (
            <>
              <div className="text-[11.5px] text-foreground/50 mb-2 px-0.5">
                已选 {selectedImages.length} 张{maxSelect ? ` / 最多 ${maxSelect} 张` : ''}
                <span className="ml-2 text-foreground/35">· hover 缩略图可预览或移除</span>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))' }}>
                {selectedImages.map((img, idx) => (
                  <div
                    key={img.id}
                    className="group relative aspect-square rounded-md overflow-hidden ring-1 ring-foreground/8"
                    title={img.file_name}
                  >
                    <ThumbnailImage
                      imageId={img.id}
                      size={300}
                      version={img.updated_at}
                      className="absolute inset-0 w-full h-full"
                    />
                    {/* hover 蒙层 + 两个操作 icon */}
                    <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/55 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setLightbox({ open: true, index: idx }) }}
                        className="h-7 w-7 rounded-md bg-white/95 text-foreground hover:bg-white flex items-center justify-center"
                        title="预览"
                      >
                        <Eye size={14} strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); removeOne(img.id) }}
                        className="h-7 w-7 rounded-md bg-white/95 text-destructive hover:bg-white flex items-center justify-center"
                        title="从种子中移除(图片仍保留在资产库)"
                      >
                        <X size={14} strokeWidth={2} />
                      </button>
                    </div>
                    {/* 文件名小条(下方半透明) */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/50 to-transparent px-1.5 py-1">
                      <p className="text-[9.5px] text-white/95 truncate">{img.file_name}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center min-h-[136px] gap-1.5 text-foreground/40">
              <Upload size={20} strokeWidth={1.4} className="text-foreground/30" />
              <div className="text-[12.5px]">把图片拖到这里 · Ctrl+V 粘贴截图 · 或点上方按钮挑选</div>
              <div className="text-[11px] text-foreground/30">支持 JPG / PNG / WebP / HEIC,单文件 ≤ 50 MB</div>
            </div>
          )}
        </div>
      </div>

      <SeedPickerDialog
        open={showPicker}
        onClose={() => setShowPicker(false)}
        initialSelected={selectedImages}
        onConfirm={(imgs) => { onSelect(imgs); setShowPicker(false) }}
        maxSelect={maxSelect}
      />

      <ImageLightbox
        open={lightbox.open}
        images={selectedImages}
        initialIndex={lightbox.index}
        onClose={() => setLightbox((s) => ({ ...s, open: false }))}
      />
    </>
  )
}

