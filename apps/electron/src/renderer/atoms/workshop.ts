import { atom } from 'jotai'

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
