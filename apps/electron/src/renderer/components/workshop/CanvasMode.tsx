import { useAtomValue } from 'jotai'

import { canvasParamsAtom } from '@/atoms/canvas'
import { workshopBatchDialogAtom } from '@/atoms/workshop'
import { CanvasStage } from '@/components/workshop/canvas/CanvasStage'
import { PromptBar } from '@/components/workshop/canvas/PromptBar'
import { HistoryPanel } from '@/components/workshop/canvas/HistoryPanel'
import { useSetAtom, useAtom } from 'jotai'
import { workshopModeAtom } from '@/atoms/workshop'

/**
 * 创作画布 mode 容器 — Phase 1 三栏布局:
 *   ┌────────────────────────────────┬─────────────┐
 *   │  CanvasStage (主白板)          │ PropertyPanel│
 *   │                                │   (右 300px) │
 *   ├────────────────────────────────┤              │
 *   │  PromptBar (底部)              │              │
 *   └────────────────────────────────┴─────────────┘
 *
 * 右面板 PropertyPanel 包含「存为策略」按钮 — canvasParamsAtom 提供快照。
 * 底部 PromptBar 是文生图 / 图生图 入口,把当前配置同步到同一 atom。
 */
export function CanvasMode() {
  const params = useAtomValue(canvasParamsAtom)
  const [, setMode] = useAtom(workshopModeAtom)
  const setShowBatch = useSetAtom(workshopBatchDialogAtom)

  // 序列化当前画布参数为「存为策略」时的 canvas_snapshot
  const snapshot: Record<string, unknown> = {
    mode: params.mode,
    prompt: params.prompt,
    target_w: params.target_w,
    target_h: params.target_h,
    ratio_label: params.ratio_label,
    speed: params.speed,
    count: params.count,
    style_archive_id: params.style_archive_id ?? null,
  }

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <CanvasStage />
        </div>
        <PromptBar />
      </div>
      <HistoryPanel
        canvasSnapshot={snapshot}
        onTransferToBatch={() => {
          setMode('batch')
          setShowBatch(true)
        }}
      />
    </div>
  )
}
