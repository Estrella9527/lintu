import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export type ModuleId =
  | 'dashboard'
  | 'pipeline'
  | 'ai-workshop'
  | 'task-center'
  | 'review-queue'
  | 'asset-library'
  | 'coverage-matrix'
  | 'match-lab'
  | 'distribution-center'
  | 'settings'

export const activeModuleAtom = atom<ModuleId>('dashboard')

/** Optional sub-tab selector for the Settings module. Set together with
 * activeModuleAtom='settings' to deep-link into a specific Settings tab. */
export type SettingsTabId =
  | 'general'
  | 'org-general'
  | 'org-members'
  | 'platform'
  | 'sms-connect'
  | 'ai-provider'
  | 'prompt-library'
  | 'tag-system'
  | 'members'
  | 'audit-log'
  | 'oss-config'
  | 'about'
export const settingsTabAtom = atom<SettingsTabId>('general')

/** Persist the sidebar collapse preference between sessions. */
export const sidebarCollapsedAtom = atomWithStorage<boolean>('lintu.sidebarCollapsed', false)


/** Cross-page deep-link request for the Asset Library. Caller sets this
 * together with `activeModuleAtom = 'asset-library'`; AssetLibrary reads
 * and applies it once on mount, then clears it. Lets any page (TaskCenter,
 * Pipeline, BatchDetailDrawer, …) say "go look at these images" without
 * prop-drilling.
 *
 * tab — which sub-tab of the asset library
 * status / source — quick filters
 * promptId — generation_metadata.prompt_id filter (only original or generated)
 * folderPrefix — relative_dir prefix
 * tags — { dim: [values] } multi-tag filter
 * parentId — show only derivatives of a given seed image
 * parentLabel — display label for the parent filter chip
 */
export interface AssetLibraryNavRequest {
  // 'match' removed in 2026-04-28: 试匹配 moved to its own top-level
  // module (匹配实验室). Old navigation requests targeting it should
  // route to `matchLabNavRequestAtom` with `{tab:'playground'}` instead.
  tab?: 'all' | 'duplicates' | 'trash' | 'favorites' | 'derivatives'
  status?: 'all' | 'passed' | 'rejected' | 'pending'
  source?: string         // FilterBar source value (original/generated/...)
  promptId?: string
  promptLabel?: string
  folderPrefix?: string
  tags?: Record<string, string[]>
  parentId?: string
  parentLabel?: string
}
export const assetLibraryNavRequestAtom = atom<AssetLibraryNavRequest | null>(null)


/** Same idea for Distribution Center: deep-link to a specific sub-tab and
 * optionally pre-filter the request log to one API key.
 *
 * Note: 'analytics' was removed in 2026-04-28 — 匹配分析 lives in
 * 匹配实验室 now (`matchLabNavRequestAtom` with tab='analytics'). */
export interface DistributionNavRequest {
  tab?: 'keys' | 'api' | 'history' | 'oss'
  filterKeyId?: string    // public key_id to filter logs by
}
export const distributionNavRequestAtom = atom<DistributionNavRequest | null>(null)


/** Match Lab cross-page deep-link request. Used by the analytics card's
 * "复跑" button (jumps to playground tab) and by potential future deep
 * links from settings/asset-library. */
export type MatchLabTab = 'playground' | 'default-strategy' | 'analytics' | 'synonyms'
export interface MatchLabNavRequest {
  tab?: MatchLabTab
}
export const matchLabNavRequestAtom = atom<MatchLabNavRequest | null>(null)
