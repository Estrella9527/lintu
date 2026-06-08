import { useAtomValue } from 'jotai'

import { canvasParamsAtom } from '@/atoms/canvas'
import { workshopBatchDialogAtom } from '@/atoms/workshop'
import { CanvasStage } from '@/components/workshop/canvas/CanvasStage'
import { PromptBar } from '@/components/workshop/canvas/PromptBar'
import { HistoryPanel } from '@/components/workshop/canvas/HistoryPanel'
import { useSetAtom, useAtom } from 'jotai'
import { workshopModeAtom } from '@/atoms/workshop'

/**
 * 创作画布 mode 容器 — 全自由画布布局:
 *   整块内容区都是 CanvasStage(自由画布)。PromptBar(底部居中固定宽)与
 *   HistoryPanel(历史记录,默认收起为右上角按钮,点开为右侧悬浮抽屉)都作为
 *   悬浮层叠在画布之上,而非占用独立栏位 —— 让画布永远占满整个区域。
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
    <div className="relative h-full w-full overflow-hidden">
      {/* 自由画布占满整个区域 */}
      <div className="absolute inset-0">
        <CanvasStage />
      </div>
      {/* 底部居中固定宽的图文输入框(悬浮) */}
      <PromptBar />
      {/* 历史记录:默认收起为右上角按钮,展开为右侧悬浮抽屉(悬浮在画布上) */}
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
