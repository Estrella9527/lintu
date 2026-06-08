import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { Plus, Rocket, Sparkles, Workflow } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  batchClonePresetAtom,
  batchSeedQueueAtom,
  workshopBatchDialogAtom,
  workshopModeAtom,
  workshopPresetAtom,
  type WorkshopMode,
} from '@/atoms/workshop'
import { Button } from '@/components/ui/button'
import { CanvasMode } from '@/components/workshop/CanvasMode'
import { BatchMode } from '@/components/workshop/BatchMode'
import { StrategyDialog } from '@/components/workshop/StrategyDialog'

const MODE_TABS: { id: WorkshopMode; label: string; icon: typeof Sparkles }[] = [
  { id: 'canvas', label: '创作画布', icon: Sparkles },
  { id: 'batch',  label: '批量策略', icon: Workflow },
]

/**
 * v0.3 AI 工坊 — 改造为「创作画布 / 批量策略」双模式容器。
 *
 * 设计原则(对齐 PRD §2):
 *   - 顶部 ModeTabs 切换,**同一时刻只展示一个模式**
 *   - 右侧两个统一入口:`新建策略`(任何 mode 都能创建)+ `批量生产`(直达批量 mode)
 *   - 三类跨页面 hand-off(资产库选区 / 任务中心复用 / 覆盖矩阵预设)
 *     自动切到 batch mode 后,由 BatchMode 接管 dialog 的打开
 *
 * 历史包袱清理:
 *   - 删除 v0.2 时期硬编码的 7 个内置 strategy tab
 *   - 现有 strategies 表数据不变 — 它们会在 BatchMode 的 strategy list 里出现
 */
export default function AIWorkshop() {
  const [mode, setMode] = useAtom(workshopModeAtom)
  const [, setShowBatch] = useAtom(workshopBatchDialogAtom)
  const [seedQueue] = useAtom(batchSeedQueueAtom)
  const [clonePreset] = useAtom(batchClonePresetAtom)
  const [preset] = useAtom(workshopPresetAtom)
  const [showCreate, setShowCreate] = useState(false)

  // 任何跨页面 hand-off 进来时,确保切到 batch mode,这样 BatchMode 才能
  // 在挂载后从 atom 拿到 seeds / preset / cloneConfig。
  useEffect(() => {
    if (
      (seedQueue && seedQueue.length > 0) ||
      clonePreset ||
      preset
    ) {
      setMode('batch')
    }
  }, [seedQueue, clonePreset, preset, setMode])

  return (
    <div className="flex h-full flex-col">
      {/* Header: title + ModeTabs (left) + actions (right) */}
      <div className="flex items-center gap-5 px-5 h-[40px] shrink-0 border-b border-foreground/5">
        <h1 className="text-[13px] font-semibold text-foreground/85 shrink-0">AI工坊</h1>
        <div className="flex gap-1">
          {MODE_TABS.map((tab) => {
            const Icon = tab.icon
            const active = mode === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setMode(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] rounded-md transition-colors',
                  active
                    ? 'bg-accent/10 text-accent'
                    : 'text-foreground/55 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                )}
              >
                <Icon size={13} strokeWidth={1.5} />
                {tab.label}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" className="text-[12px] h-7"
                  onClick={() => setShowCreate(true)}>
            <Plus size={12} className="mr-1" /> 新建策略
          </Button>
          <Button
            size="sm" className="text-[12px] h-7"
            onClick={() => { setMode('batch'); setShowBatch(true) }}
          >
            <Rocket size={12} className="mr-1" /> 批量生产
          </Button>
        </div>
      </div>

      {/* Mode body — 同一时刻仅渲染一个 mode 的子树 */}
      <div className="flex-1 min-h-0">
        {mode === 'canvas' ? <CanvasMode /> : <BatchMode />}
      </div>

      <StrategyDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        strategy={null}
        onSaved={() => setShowCreate(false)}
      />
    </div>
  )
}
