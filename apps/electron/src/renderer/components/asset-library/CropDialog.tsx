import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Crop as CropIcon, Loader2 } from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

interface CropDialogProps {
  imageId: string
  fileName?: string
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 裁切成功后回调(用于刷新网格/详情) */
  onDone?: () => void
}

interface Rect { x: number; y: number; w: number; h: number }  // 展示像素

/** 资产库任意裁切:拖拽框选保留区域 → 原地覆盖原图(不备份)。 */
export function CropDialog({ imageId, fileName, open, onOpenChange, onDone }: CropDialogProps) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [drag, setDrag] = useState<{ sx: number; sy: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  const reset = () => { setDrag(null); setRect(null) }

  // 把 clientX/Y 换算成相对展示图左上角的像素,并 clamp 到图内
  const toLocal = (clientX: number, clientY: number) => {
    const r = imgRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(r.width, clientX - r.left)),
      y: Math.max(0, Math.min(r.height, clientY - r.top)),
    }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (!imgRef.current) return
    e.preventDefault()
    const p = toLocal(e.clientX, e.clientY)
    setDrag({ sx: p.x, sy: p.y })
    setRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag || !imgRef.current) return
    const p = toLocal(e.clientX, e.clientY)
    setRect({
      x: Math.min(drag.sx, p.x),
      y: Math.min(drag.sy, p.y),
      w: Math.abs(p.x - drag.sx),
      h: Math.abs(p.y - drag.sy),
    })
  }
  const onMouseUp = () => setDrag(null)

  const crop = useMutation({
    mutationFn: () => {
      const el = imgRef.current!
      const dispW = el.getBoundingClientRect().width
      const dispH = el.getBoundingClientRect().height
      const r = rect!
      // 归一化到 0..1,后端按原图真实像素换算
      return api.images.crop(imageId, {
        x: r.x / dispW,
        y: r.y / dispH,
        width: r.w / dispW,
        height: r.h / dispH,
      })
    },
    onSuccess: (d) => {
      toast.success(`已裁切为 ${d.width} × ${d.height}`)
      reset()
      onOpenChange(false)
      onDone?.()
    },
    onError: (e: any) => toast.error(e?.message || '裁切失败'),
  })

  const hasSel = !!rect && rect.w > 4 && rect.h > 4

  const handleConfirm = () => {
    if (!hasSel) return
    if (!window.confirm(
      '裁切会直接覆盖原图,不保留备份,操作不可撤销。\n\n只保留框选区域,确定继续？'
    )) return
    crop.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-w-[880px]">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-1.5">
            <CropIcon size={15} /> 裁切 · {fileName || imageId}
          </DialogTitle>
        </DialogHeader>

        <div className="text-[11px] text-warning bg-warning/10 rounded px-2 py-1.5">
          在图上按住鼠标拖拽出要保留的区域。裁切会<strong>直接覆盖原图、不备份</strong>,请谨慎。
        </div>

        <div className="flex items-center justify-center bg-foreground/[0.04] rounded-md p-2 max-h-[62vh] overflow-hidden">
          <div className="relative inline-block leading-none select-none">
            <img
              ref={imgRef}
              src={api.images.fileUrl(imageId)}
              alt={fileName}
              draggable={false}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              className="block max-w-full max-h-[58vh] cursor-crosshair"
            />
            {rect && (
              <>
                {/* 暗化未选中区域(四条遮罩) */}
                <div className="absolute inset-0 pointer-events-none">
                  <div
                    className="absolute border-2 border-accent bg-accent/10"
                    style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="text-[11px] text-foreground/45 mr-auto">
            {hasSel
              ? `已选区域约 ${Math.round(rect!.w)} × ${Math.round(rect!.h)} px(展示尺寸)`
              : '拖拽框选要保留的区域'}
          </span>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={reset} disabled={!rect || crop.isPending}>
            重选
          </Button>
          <Button size="sm" className="h-8 text-[12px]" onClick={handleConfirm} disabled={!hasSel || crop.isPending}>
            {crop.isPending ? <><Loader2 size={13} className="mr-1 animate-spin" />裁切中…</> : '确认裁切(覆盖原图)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
