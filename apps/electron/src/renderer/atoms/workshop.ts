import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ImageRecord } from '@/lib/types'

export interface WorkshopPreset {
  strategy: string
  params: Record<string, any>
  seedFilter?: {
    scene?: string
    season?: string
    excludeSeason?: string
  }
}

export const workshopPresetAtom = atom<WorkshopPreset | null>(null)

/** Cross-page hand-off: when set, AIWorkshop auto-opens BatchRunDialog with
 * these images preselected as seeds. Set by AssetLibrary's BatchActionBar.
 * Consumer must clear it after consuming to avoid re-trigger on re-mount. */
export const batchSeedQueueAtom = atom<ImageRecord[] | null>(null)

/** Full batch-config clone for "复用此批次配置" — set by TaskCenter's
 * BatchList button. Includes every parameter so the user can re-launch
 * an identical batch without re-picking 60 prompts and 5 seeds by hand.
 * AIWorkshop pops the dialog with everything preselected. */
export interface BatchClonePreset {
  taskType: string
  name: string
  seeds: ImageRecord[]
  promptIds: string[]
  concurrency: number
  maxRetry: number
  budgetUsd: number | null
  providerChain: string[] | null
}
export const batchClonePresetAtom = atom<BatchClonePreset | null>(null)

/**
 * 工坊种子图选区 — 按 `${projectId}:${taskType}` 分桶持久化在 jotai 内存里。
 *
 * 为什么不存盘:种子图是会话内的"草稿",不该跨重启复活;但**切 tab / 切到别的
 * 模块再回来**(StrategyPage 组件 unmount 重建)绝对不能丢。所以放 atom 就够了。
 *
 * 为什么按 project + taskType 分桶:
 *   - 不同项目的图 id 没有意义,跨项目共享会渲染失败
 *   - 不同 strategy(画布扩展 vs 季节变换)的种子语义不同,跨 tab 共享会让
 *     用户疑惑"我刚才选的图怎么跑到这个 tab 了"
 */
export const workshopSeedsByKeyAtom = atom<Record<string, ImageRecord[]>>({})

export const workshopSeedsKey = (projectId: string | null | undefined, taskType: string) =>
  `${projectId ?? '__noproject__'}:${taskType}`

// v0.3 ModeTabs:AI 工坊改造为「创作画布 / 批量策略」双模式,同一时刻只显示一个。
// 切换在 atom 里,这样别处(资产库批量上传 / 任务中心复用批次)能直接跳到批量 mode。
export type WorkshopMode = 'canvas' | 'batch'
// 持久化:刷新 / 重启后保持在上次的 mode(配合 activeModuleAtom 持久化,
// 让"画布创作中刷新 → 直接回到画布继续"成立)。getOnInit:true 必须。
export const workshopModeAtom = atomWithStorage<WorkshopMode>(
  'lintu.workshopMode',
  'canvas',
  undefined,
  { getOnInit: true },
)

// 批量生产对话框可见性。提到 atom 是因为入口分散:
//   - AI 工坊页头部「批量生产」按钮
//   - 资产库选区 → 批量(通过 batchSeedQueueAtom 触发)
//   - 任务中心「复用此批次配置」(通过 batchClonePresetAtom 触发)
// BatchMode 监听本 atom 决定是否展开 dialog。
export const workshopBatchDialogAtom = atom<boolean>(false)

// v0.3 PR-12:「一键转批量」真打通 — 创作画布存为策略后写入这个 atom,
// BatchMode 监听 → 自动 setActiveId(strategy.id),让用户直接看到刚保存的策略
// 已被选中(配置预填)。BatchMode 消费后立即清空。
export const autoSelectStrategyAtom = atom<string | null>(null)
