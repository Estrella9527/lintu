import { useEffect, useState } from 'react'
import { Loader2, Maximize2, Sparkles } from 'lucide-react'

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface OutpaintDialogProps {
  open: boolean
  onClose: () => void
  sourceWidth: number
  sourceHeight: number
  busy: boolean
  onConfirm: (targetW: number, targetH: number) => void
}

const PRESETS: Array<{ label: string; ratioW: number; ratioH: number }> = [
  { label: '1:1',  ratioW: 1, ratioH: 1 },
  { label: '4:3',  ratioW: 4, ratioH: 3 },
  { label: '3:4',  ratioW: 3, ratioH: 4 },
  { label: '16:9', ratioW: 16, ratioH: 9 },
  { label: '9:16', ratioW: 9, ratioH: 16 },
  { label: '21:9', ratioW: 21, ratioH: 9 },
]

/**
 * 任意尺寸扩图配置弹窗 — Phase 1 简化版。
 *
 * PRD §3.3 要求是「8 手柄拖宽高」+「自定义比例 / WxH 输入」两条路径。
 * Phase 1 先给数字输入 + 预设比例,UX 上是 Modal 而不是画布内的 8 手柄。
 * 真 8 手柄交互留作 PR-6.1 follow-up — 这样 PR-6 主流程能尽快上线,
 * 核心能力(任意 W/H 输出)不缺。
 *
 * 行为:
 *   - 显示当前选中图的原始尺寸 W×H
 *   - 用户改 target_w / target_h(或点预设比例,自动按短边补足)
 *   - 实时显示扩图增量(横向 +X / 纵向 +Y)+ 提示原图区域像素保真
 *   - 点「生成」回调 onConfirm
 */
export function OutpaintDialog({
  open, onClose, sourceWidth, sourceHeight, busy, onConfirm,
}: OutpaintDialogProps) {
  const [targetW, setTargetW] = useState(sourceWidth)
  const [targetH, setTargetH] = useState(sourceHeight)

  // 弹窗每次打开重置为当前原图尺寸,避免上次用户改过的数字混淆
  useEffect(() => {
    if (open) {
      setTargetW(sourceWidth)
      setTargetH(sourceHeight)
    }
  }, [open, sourceWidth, sourceHeight])

  const applyPreset = (rw: number, rh: number) => {
    // 按短边对齐:让目标至少包含原图,然后按 ratio 补齐另一边
    const minLong = Math.max(sourceWidth, sourceHeight, 1024)
    if (rw >= rh) {
      // 宽更大 — 拉宽
      const h = Math.round(minLong * rh / rw)
      const w = Math.round(minLong)
      setTargetW(Math.max(w, sourceWidth))
      setTargetH(Math.max(h, sourceHeight))
    } else {
      const w = Math.round(minLong * rw / rh)
      const h = Math.round(minLong)
      setTargetW(Math.max(w, sourceWidth))
      setTargetH(Math.max(h, sourceHeight))
    }
  }

  const deltaW = targetW - sourceWidth
  const deltaH = targetH - sourceHeight
  const invalid = targetW < sourceWidth || targetH < sourceHeight ||
                  targetW < 64 || targetH < 64 || targetW > 8192 || targetH > 8192

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px] inline-flex items-center gap-1.5">
            <Maximize2 size={13} className="text-accent" /> 任意尺寸扩图
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="rounded-md bg-foreground/[0.02] border border-foreground/8 p-2.5 text-[11.5px] text-foreground/55 leading-relaxed">
            原图尺寸 <strong className="text-foreground/80 tabular-nums">{sourceWidth} × {sourceHeight}</strong> ·
            目标尺寸必须 ≥ 原图 · 原图像素保真,仅新增区域生成
          </div>

          <div>
            <label className="text-[11.5px] text-foreground/55 mb-1.5 block">预设比例(以原图长边为基准)</label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p.ratioW, p.ratioH)}
                  className="h-7 px-2.5 rounded-md text-[11.5px] text-foreground/65
                             border border-foreground/12 hover:bg-foreground/[0.05]
                             hover:text-foreground transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55">目标宽 (px)</label>
              <Input
                type="number"
                min={Math.max(64, sourceWidth)}
                max={8192}
                value={targetW}
                onChange={(e) => setTargetW(Number(e.target.value) || sourceWidth)}
                className="h-8 text-[12.5px] tabular-nums"
              />
              <div className={cn('text-[10.5px] tabular-nums', deltaW > 0 ? 'text-accent' : 'text-foreground/40')}>
                {deltaW > 0 ? `+${deltaW} px` : '不变'}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55">目标高 (px)</label>
              <Input
                type="number"
                min={Math.max(64, sourceHeight)}
                max={8192}
                value={targetH}
                onChange={(e) => setTargetH(Number(e.target.value) || sourceHeight)}
                className="h-8 text-[12.5px] tabular-nums"
              />
              <div className={cn('text-[10.5px] tabular-nums', deltaH > 0 ? 'text-accent' : 'text-foreground/40')}>
                {deltaH > 0 ? `+${deltaH} px` : '不变'}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            size="sm"
            disabled={busy || invalid}
            onClick={() => onConfirm(targetW, targetH)}
          >
            {busy
              ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> 生成中</>
              : <><Sparkles size={12} className="mr-1.5" /> 生成 · {targetW}×{targetH}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
