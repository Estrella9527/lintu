import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { ImageGrid } from '@/components/asset-library/ImageGrid'
import { Target, FolderOpen, Filter } from 'lucide-react'
import type { ImageRecord } from '@/lib/types'

interface SeedSelectorProps {
  selectedImages: ImageRecord[]
  onSelect: (images: ImageRecord[]) => void
  maxSelect?: number
}

export function SeedSelector({ selectedImages, onSelect, maxSelect }: SeedSelectorProps) {
  const [showPicker, setShowPicker] = useState(false)
  const projectId = useAtomValue(activeProjectIdAtom)

  const handlePickImage = (img: ImageRecord) => {
    if (selectedImages.find((s) => s.id === img.id)) {
      onSelect(selectedImages.filter((s) => s.id !== img.id))
    } else if (!maxSelect || selectedImages.length < maxSelect) {
      onSelect([...selectedImages, img])
    }
  }

  return (
    <>
      <div className="space-y-3">
        {/* Source options */}
        <div className="flex gap-2">
          <Button
            variant="outline" size="sm" className="text-[12px] h-8"
            onClick={() => setShowPicker(true)}
          >
            <FolderOpen size={13} className="mr-1.5" />
            从资产库选择
          </Button>
        </div>

        {/* Selected preview */}
        {selectedImages.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] text-foreground/50">
                已选 {selectedImages.length} 张
                {maxSelect && <span> / 最多 {maxSelect} 张</span>}
              </span>
              <Button variant="ghost" size="sm" className="text-[11px] h-6 text-foreground/40" onClick={() => onSelect([])}>
                清空
              </Button>
            </div>
            <div className="flex gap-2 flex-wrap">
              {selectedImages.slice(0, 8).map((img) => (
                <ThumbnailImage
                  key={img.id}
                  imageId={img.id}
                  size={128}
                  className="w-16 h-16 rounded-md"
                  onClick={() => handlePickImage(img)}
                />
              ))}
              {selectedImages.length > 8 && (
                <div className="w-16 h-16 rounded-md bg-foreground/[0.04] flex items-center justify-center text-[12px] text-foreground/40">
                  +{selectedImages.length - 8}
                </div>
              )}
            </div>
          </div>
        )}

        {selectedImages.length === 0 && (
          <div className="flex items-center justify-center h-16 rounded-md bg-foreground/[0.02] text-[12px] text-foreground/30">
            点击上方按钮选择种子图
          </div>
        )}
      </div>

      {/* Image picker dialog */}
      <Dialog open={showPicker} onOpenChange={setShowPicker}>
        <DialogContent className="sm:max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-[15px]">选择种子图</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto">
            {projectId ? (
              <ImageGrid
                projectId={projectId}
                status="passed"
                onSelectImage={handlePickImage}
              />
            ) : (
              <div className="text-center py-12 text-[13px] text-foreground/30">请先选择项目</div>
            )}
          </div>
          <div className="flex justify-between items-center pt-3 border-t border-foreground/5">
            <span className="text-[12px] text-foreground/50">已选 {selectedImages.length} 张</span>
            <Button size="sm" onClick={() => setShowPicker(false)}>确定</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
