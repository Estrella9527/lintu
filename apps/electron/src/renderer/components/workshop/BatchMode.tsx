import { useEffect, useMemo, useState } from 'react'
import { useAtom } from 'jotai'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetchRaw } from '@/lib/api'
import { cn } from '@/lib/utils'
import { matchIcon } from '@/lib/icon-map'
import {
  autoSelectStrategyAtom,
  batchClonePresetAtom,
  batchSeedQueueAtom,
  workshopBatchDialogAtom,
  workshopModeAtom,
  workshopPresetAtom,
} from '@/atoms/workshop'
import { canvasParamsAtom } from '@/atoms/canvas'
import { toast } from 'sonner'
import { BatchRunDialog } from '@/components/workshop/BatchRunDialog'
import { StrategyPage } from '@/components/workshop/StrategyPage'
import { StrategyDialog, type StrategyRecord } from '@/components/workshop/StrategyDialog'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

/**
 * 批量策略 mode 容器 — PR-3 阶段提供"功能不变"的兼容层:
 *   - 顶部"批量生产"主按钮 → 弹现有的 BatchRunDialog(完整的 4 步流程)
 *   - 中部 strategy tabs + StrategyPage(保留 v0.2 的内置策略 + 用户自建策略)
 *   - 跨页面 hand-off(资产库选区 → 批量 / 任务中心复用批次)继续生效
 *
 * PR-7 会把 BatchRunDialog 整合到一个三栏 mode 内部(策略库 + 配置 + 任务摘要),
 * 一键转批量 / 回画布微调 / 覆盖矩阵联动 在那时一起落。
 */
export function BatchMode() {
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string>('')
  const [preset, setPreset] = useAtom(workshopPresetAtom)
  const [editingStrategy, setEditingStrategy] = useState<StrategyRecord | null>(null)
  const [showBatch, setShowBatch] = useAtom(workshopBatchDialogAtom)
  const [seedQueue, setSeedQueue] = useAtom(batchSeedQueueAtom)
  const [clonePreset, setClonePreset] = useAtom(batchClonePresetAtom)
  const [, setMode] = useAtom(workshopModeAtom)
  const [, setCanvasParams] = useAtom(canvasParamsAtom)
  const [autoSelect, setAutoSelect] = useAtom(autoSelectStrategyAtom)

  const { data: strategies, isLoading } = useQuery<StrategyRecord[]>({
    queryKey: ['strategies'],
    queryFn: () => apiFetchRaw('/strategies').then((r) => r.json()),
  })

  // 「一键转批量」打通:画布存策略 → autoSelectStrategyAtom 写 id → 这里监听 → 自动选中
  // 注意:必须在 useQuery 之后声明,否则 TS TDZ 错(strategies 还未定义)
  useEffect(() => {
    if (autoSelect && strategies?.some((s) => s.id === autoSelect)) {
      setActiveId(autoSelect)
      setAutoSelect(null)
    }
  }, [autoSelect, strategies, setAutoSelect])

  // Auto-select first strategy on mount
  useEffect(() => {
    if (strategies?.length && !activeId) setActiveId(strategies[0].id)
  }, [strategies, activeId])

  // Cross-page hand-offs auto-open the batch dialog
  useEffect(() => {
    if (seedQueue && seedQueue.length > 0 && !showBatch) setShowBatch(true)
  }, [seedQueue, showBatch])
  useEffect(() => {
    if (clonePreset && !showBatch) setShowBatch(true)
  }, [clonePreset, showBatch])

  // Coverage matrix → workshop preset:把 strategy 切到匹配的 task_type 上
  useEffect(() => {
    if (preset && strategies) {
      const match = strategies.find((s) => s.task_type === preset.strategy)
      if (match) setActiveId(match.id)
    }
  }, [preset, strategies])

  const activeStrategy = useMemo(
    () => strategies?.find((s) => s.id === activeId) || null,
    [strategies, activeId],
  )

  const activeFields: FieldConfig[] = useMemo(() => {
    if (!activeStrategy) return []
    try { return JSON.parse(activeStrategy.parameters) } catch { return [] }
  }, [activeStrategy])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30">
        加载策略...
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Strategy tabs(保留 v0.2 的策略 list,from_canvas 来源加 📐 标识 + 「回画布微调」按钮)
          —— 「批量生产」按钮被提升到 AIWorkshop 页头部,统一两个 mode 的入口 */}
      <div className="px-5 pt-3 shrink-0">
        <div className="flex gap-1 flex-wrap">
          {strategies?.map((s) => {
            const Icon = matchIcon(s.icon_keyword, s.name)
            const isActive = activeId === s.id
            const fromCanvas = s.provenance === 'from_canvas'
            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] rounded-md transition-colors group',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                )}
                title={fromCanvas ? '来自创作画布的策略 · 可回画布微调' : undefined}
              >
                <Icon size={14} strokeWidth={1.5} />
                {s.name}
                {fromCanvas && (
                  <span className="text-[10px] text-foreground/40">📐</span>
                )}
                {fromCanvas && (
                  <span
                    className="opacity-0 group-hover:opacity-100 hover:underline ml-0.5 text-[10px] text-foreground/55"
                    onClick={(e) => {
                      e.stopPropagation()
                      // 「回画布微调」 — 把 canvas_snapshot 还原到 canvasParamsAtom,切到 canvas mode
                      const snap = s.canvas_snapshot as Record<string, any> | null | undefined
                      if (snap && typeof snap === 'object') {
                        setCanvasParams({
                          mode: (snap.mode as 'text2img' | 'img2img') || 'text2img',
                          prompt: String(snap.prompt || ''),
                          target_w: Number(snap.target_w) || 1024,
                          target_h: Number(snap.target_h) || 1024,
                          ratio_label: String(snap.ratio_label || '1:1'),
                          speed: (snap.speed as 'draft' | 'refined') || 'refined',
                          count: Number(snap.count) || 1,
                          style_archive_id: (snap.style_archive_id as string) || null,
                        })
                      }
                      setMode('canvas')
                      toast.success(`已把「${s.name}」载回画布`)
                    }}
                  >
                    回画布
                  </span>
                )}
                {!s.is_builtin && (
                  <button
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 ml-0.5"
                    onClick={(e) => { e.stopPropagation(); setEditingStrategy(s) }}
                    aria-label="编辑策略"
                  >
                    ✎
                  </button>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
        {activeStrategy ? (
          <StrategyPage
            key={activeStrategy.id}
            taskType={activeStrategy.task_type}
            fields={activeFields}
            strategyId={activeStrategy.id}
          />
        ) : (
          <div className="text-center py-20 text-[13px] text-foreground/30">
            选择或创建一个策略
          </div>
        )}
      </div>

      <BatchRunDialog
        open={showBatch}
        onClose={() => {
          setShowBatch(false)
          setSeedQueue(null)
          setClonePreset(null)
          setPreset(null)
        }}
        defaultTaskType={clonePreset?.taskType || activeStrategy?.task_type}
        defaultStrategyId={activeStrategy?.id}
        initialSeeds={clonePreset?.seeds || seedQueue || undefined}
        preset={clonePreset ? {
          name: clonePreset.name,
          promptIds: clonePreset.promptIds,
          concurrency: clonePreset.concurrency,
          maxRetry: clonePreset.maxRetry,
          budgetUsd: clonePreset.budgetUsd,
          providerChain: clonePreset.providerChain,
        } : undefined}
      />

      <StrategyDialog
        open={!!editingStrategy}
        onClose={() => setEditingStrategy(null)}
        strategy={editingStrategy}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['strategies'] })
          setEditingStrategy(null)
        }}
      />
    </div>
  )
}
