import { useEffect, useMemo } from 'react'
import { CheckCircle2, Cloud, HardDrive, ImageDown, Layers, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
const EMPTY_FILES: File[] = []

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

interface UploadBatchDialogProps {
  open: boolean
  fileCount: number
  totalBytes?: number
  /** 新文件在真正保存前展示出来，允许逐张移除，避免误上传。 */
  files?: File[]
  busy?: boolean
  progress?: { done: number; total: number }
  onOpenChange: (v: boolean) => void
  /** 用户确认后直接入图库；压缩完成后自动同步 OSS。 */
  onConfirm: () => void
  onRemoveFile?: (index: number) => void
  onClearFiles?: () => void
  /** 取消(丢弃待传文件) */
  onCancel: () => void
}

/** 上传前的最终确认：可逐张移除，避免不需要的图片进入图库 / OSS。 */
export function UploadBatchDialog({
  open,
  fileCount,
  totalBytes,
  files = EMPTY_FILES,
  busy = false,
  progress,
  onOpenChange,
  onConfirm,
  onRemoveFile,
  onClearFiles,
  onCancel,
}: UploadBatchDialogProps) {
  const close = (v: boolean) => {
    if (!v && busy) return
    if (!v) onCancel()
    onOpenChange(v)
  }
  const sizeLabel = totalBytes != null ? formatBytes(totalBytes) : null
  // 临时对象 URL 只存在于「确认前」的本地选择区；关闭或移除后立即回收。
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  )
  useEffect(() => () => previews.forEach(({ url }) => URL.revokeObjectURL(url)), [previews])

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[14px] flex items-center gap-1.5">
            <Layers size={15} /> 上传到图库 · 共 {fileCount} 张
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-lg border border-foreground/8 bg-foreground/[0.02] px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between text-[11.5px]">
            <span className="text-foreground/70">已选择 {fileCount.toLocaleString()} 张图片</span>
            {sizeLabel && <span className="text-foreground/40 tabular-nums">{sizeLabel}</span>}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10.5px] text-foreground/55">
            <span className="inline-flex items-center gap-1"><HardDrive size={11} className="text-success" /> 原图保存在本地</span>
            <span className="inline-flex items-center gap-1"><ImageDown size={11} className="text-success" /> 自动生成压缩发布版</span>
            <span className="inline-flex items-center gap-1"><Cloud size={11} className="text-success" /> 压缩完成后同步 OSS</span>
            <span className="inline-flex items-center gap-1"><CheckCircle2 size={11} className="text-success" /> UGC 上架仍需手动开启</span>
          </div>
          <p className="text-[10.5px] text-foreground/40 leading-relaxed">
            现在只是待确认选择，尚未保存到本地、更未上传 OSS。确认后会直接进入图库；可先移除不需要的图片，避免误上传。
          </p>
        </div>

        {files.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12px] text-foreground/70">确认本次图片</div>
              <button
                type="button"
                disabled={busy}
                onClick={onClearFiles}
                className="text-[11px] text-foreground/45 hover:text-destructive disabled:opacity-40"
              >
                清空本次选择
              </button>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md border border-foreground/10 divide-y divide-foreground/[0.06]">
              {previews.map(({ file, url }, index) => (
                <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-2 px-2 py-1.5">
                  <img
                    src={url}
                    alt=""
                    className="h-8 w-8 rounded object-cover bg-foreground/[0.05]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] text-foreground/75" title={file.name}>{file.name}</div>
                    <div className="text-[10px] text-foreground/40 tabular-nums">{formatBytes(file.size)}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`移除 ${file.name}`}
                    title="从本次选择中移除"
                    disabled={busy}
                    onClick={() => onRemoveFile?.(index)}
                    className="rounded p-1 text-foreground/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {busy && progress && progress.total > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10.5px] text-foreground/45">
              <span>正在上传到图库</span>
              <span className="tabular-nums">{progress.done} / {progress.total}</span>
            </div>
            <div className="h-1.5 rounded-full bg-foreground/[0.06] overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.min(100, Math.round(progress.done / progress.total * 100))}%` }}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => close(false)} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm" className="h-8 text-[12px]"
            disabled={busy || fileCount === 0}
            onClick={onConfirm}
          >
            {busy && <Loader2 size={12} className="mr-1.5 animate-spin" />}
            {busy
              ? '正在上传…'
              : `上传到图库 ${fileCount.toLocaleString()} 张`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
