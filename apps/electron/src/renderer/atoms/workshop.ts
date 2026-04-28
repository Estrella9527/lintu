import { atom } from 'jotai'
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
