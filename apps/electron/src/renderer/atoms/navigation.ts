import { atom } from 'jotai'

export type ModuleId =
  | 'dashboard'
  | 'pipeline'
  | 'ai-workshop'
  | 'task-center'
  | 'asset-library'
  | 'coverage-matrix'
  | 'distribution-center'
  | 'settings'

export const activeModuleAtom = atom<ModuleId>('dashboard')
