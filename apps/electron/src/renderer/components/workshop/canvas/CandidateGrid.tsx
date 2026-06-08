import { AlertCircle, Loader2, RotateCw, Sparkles } from 'lucide-react'

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { cn } from '@/lib/utils'
import type { GenerationCandidate } from '@/lib/canvasGenerate'

interface CandidateGridProps {
  open: boolean
  onClose: () => void
  candidates: GenerationCandidate[]
  /** 用户选了某张后想怎么处理 */
  onApply: (cand: GenerationCandidate, action: 'replace' | 'add') => void
  /** 操作类型,用于头部文案 */
  opLabel: string
  /** 元数据:成本 / 是否原图保真 */
  costUsd?: number
  /** 是否允许"替换原图"(text2img 时通常没有原图可替换) */
  canReplace?: boolean
  /** 载入态 — 显示骨架卡片(PRD §6.2 候选位置占位) */
  loading?: boolean
  /** 预计生成数量(loading 时显示几个骨架) */
  expectedCount?: number
  /** 错误态 — 显示 inline error banner + retry 按钮(PRD §6.2 错误态保留参数 + 可重试) */
  errorMessage?: string | null
  onRetry?: () => void
}

/**
 * 候选变体网格 — 一次生成 N 张候选后弹出来,用户单击挑一张应用到画布。
 *
 * Phase 1 简化:每张提供两个动作 — 替换 / 新增。不做"再来 N 张"按钮
 * (用户重新点 ContextBar 的按钮即可,避免在弹层里再嵌一层生成 loading)。
 */
export function CandidateGrid({
  open, onClose, candidates, onApply, opLabel, costUsd, canReplace = true,
  loading = false, expectedCount = 2, errorMessage = null, onRetry,
}: CandidateGridProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl p-0 overflow-hidden">
        <DialogHeader className="px-5 py-3 border-b border-foreground/5">
          <DialogTitle className="text-[14px] font-medium inline-flex items-center gap-1.5">
            {loading
              ? <Loader2 size={13} className="text-accent animate-spin" />
              : errorMessage
                ? <AlertCircle size={13} className="text-destructive" />
                : <Sparkles size={13} className="text-accent" />}
            {opLabel} {loading
              ? ` · 生成中(${expectedCount} 张)`
              : errorMessage
                ? ' · 失败'
                : ` · ${candidates.length} 张候选`}
            {typeof costUsd === 'number' && !loading && !errorMessage && (
              <span className="ml-2 text-[11px] font-normal text-foreground/45 tabular-nums">
                · 本次消费 ${costUsd.toFixed(4)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="p-5">
          {/* 错误态优先 */}
          {errorMessage ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-destructive/30 bg-destructive/[0.04] p-3 flex gap-3">
                <AlertCircle size={16} className="text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-medium text-foreground/85">生成失败</div>
                  <div className="text-[11.5px] text-foreground/55 mt-0.5 break-all">{errorMessage}</div>
                  <div className="text-[10.5px] text-foreground/40 mt-1.5">原参数已保留 · 点重试不会丢失任何输入</div>
                </div>
              </div>
              {onRetry && (
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
                  <Button size="sm" onClick={onRetry}>
                    <RotateCw size={11} className="mr-1.5" /> 重试
                  </Button>
                </div>
              )}
            </div>
          ) : loading ? (
            // 载入骨架 — 替代 toast loading
            <div className={cn(
              'grid gap-3',
              expectedCount === 1 && 'grid-cols-1',
              expectedCount === 2 && 'grid-cols-2',
              expectedCount >= 3 && 'grid-cols-2 md:grid-cols-3',
            )}>
              {Array.from({ length: expectedCount }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-square rounded-lg bg-foreground/[0.04] animate-pulse
                             flex items-center justify-center text-foreground/30"
                >
                  <Loader2 size={20} className="animate-spin opacity-60" />
                </div>
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-foreground/40">
              没有候选 — 可能模型返回了空数据,试试重新生成
            </div>
          ) : (
            <div className={cn(
              'grid gap-3',
              candidates.length === 1 && 'grid-cols-1',
              candidates.length === 2 && 'grid-cols-2',
              candidates.length >= 3 && 'grid-cols-2 md:grid-cols-3',
            )}>
              {candidates.map((c, i) => (
                <div
                  key={c.image_id}
                  className="group relative rounded-lg overflow-hidden ring-1 ring-foreground/8"
                >
                  <ThumbnailImage
                    imageId={c.image_id}
                    size={800}
                    className="w-full aspect-square object-cover bg-foreground/[0.04]"
                  />
                  <Badge
                    variant="secondary"
                    className="absolute top-2 left-2 text-[10px] px-1.5 py-0
                               bg-background/85 backdrop-blur-sm text-foreground/70"
                  >
                    {c.quality === 'draft' ? '草稿' : '精修'} · {c.w}×{c.h}
                  </Badge>
                  <div className="absolute inset-x-0 bottom-0 p-2
                                  bg-gradient-to-t from-black/65 via-black/40 to-transparent
                                  opacity-0 group-hover:opacity-100 transition-opacity
                                  flex gap-2 justify-end">
                    {canReplace && (
                      <Button
                        size="sm" variant="outline"
                        className="h-7 text-[11px] bg-background/95"
                        onClick={() => onApply(c, 'replace')}
                      >
                        替换原图
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="h-7 text-[11px]"
                      onClick={() => onApply(c, 'add')}
                    >
                      新增到画布
                    </Button>
                  </div>
                  <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[10.5px] text-foreground/0 group-hover:text-foreground/0">
                    {i + 1}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-foreground/5">
          <span className="text-[11px] text-foreground/45 mr-auto">
            没看上?关掉这个窗口,在 ContextBar 重新点一次即可。所有候选已自动入资产库。
          </span>
          <Button variant="outline" size="sm" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
