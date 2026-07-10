import { useState } from 'react'
import { Layers } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export const SOURCE_CHANNELS = ['AI生产', '摄影补拍', 'UGC投稿', 'OTA授权'] as const

interface UploadBatchDialogProps {
  open: boolean
  fileCount: number
  onOpenChange: (v: boolean) => void
  /** 确认后回调:带来源类型 + 备注,宿主据此建批次并上传 */
  onConfirm: (sourceChannel: string, note: string) => void
  /** 取消(丢弃待传文件) */
  onCancel: () => void
}

/** 上传前的批次登记:来源类型(必选)+ 备注(可选)。
 *  治理策略:批次化上传 + 上传即进「暂存」,审核通过才进正式库。 */
export function UploadBatchDialog({ open, fileCount, onOpenChange, onConfirm, onCancel }: UploadBatchDialogProps) {
  const [channel, setChannel] = useState('')
  const [note, setNote] = useState('')

  const reset = () => { setChannel(''); setNote('') }
  const close = (v: boolean) => { if (!v) { reset(); onCancel() } ; onOpenChange(v) }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-1.5">
            <Layers size={15} /> 登记上传批次 · 共 {fileCount} 张
          </DialogTitle>
        </DialogHeader>

        <div className="text-[11px] text-foreground/55 bg-foreground/[0.03] rounded px-2.5 py-2 leading-relaxed">
          这批图会先进「<span className="text-accent">暂存区</span>」等待审核。审核通过后进正式库、传 OSS 并同步给 UGC；
          是否被 UGC 调用由 UGC 后台自行选择上架。登记来源便于日后追溯 / 整批退回。
        </div>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <label className="text-[12px] text-foreground/70">来源类型 <span className="text-destructive">*</span></label>
            <div className="flex flex-wrap gap-1.5">
              {SOURCE_CHANNELS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannel(c)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-[12px] border transition-colors',
                    channel === c
                      ? 'bg-accent/15 text-accent border-accent/40'
                      : 'border-foreground/12 text-foreground/65 hover:border-accent/30',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] text-foreground/70">批次备注（可选）</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：某景区 6 月补拍"
              className="w-full h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => close(false)}>
            取消
          </Button>
          <Button
            size="sm" className="h-8 text-[12px]"
            disabled={!channel}
            onClick={() => { onConfirm(channel, note); reset() }}
          >
            登记并上传（进暂存）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
