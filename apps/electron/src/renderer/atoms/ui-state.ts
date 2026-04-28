/**
 * Per-page UI state lifted to atoms so it survives navigation between
 * sidebar modules (which unmount the page). Session-scoped only — these
 * reset on app restart by design.
 *
 * What we DO persist: tab selection, filters, sort order, panel collapse —
 * anything the user explicitly set and would re-set on return.
 *
 * What we do NOT persist: selected items, hovered/focused row, drawer open
 * state, lightbox state. These reference live data that may have been
 * deleted, or expose a "still selected?" surprise on return.
 */
import { atom } from 'jotai'

import { EMPTY_FILTER, type FilterState } from '@/components/asset-library/FilterBar'

// ── Asset Library ──────────────────────────────────────────────────────────
export const assetLibraryActiveTabAtom = atom<string>('all')
export const assetLibraryFilterAtom = atom<FilterState>({ ...EMPTY_FILTER })
export const assetLibrarySelectedFolderAtom = atom<string | null>(null)

// MatchPlayground "候选来源" toggle — persists across navigation so the
// user doesn't have to re-pick "仅 AI 生成图" each time they come back.
export type MatchSourceFilter = 'all' | 'generated' | 'original'
export const matchSourceFilterAtom = atom<MatchSourceFilter>('all')

// ── Task Center ────────────────────────────────────────────────────────────
export const taskCenterActiveTabAtom = atom<string>('batches')

// ── Distribution Center ────────────────────────────────────────────────────
export const distributionActiveTabAtom = atom<string>('keys')
export const requestLogSelectedKeyAtom = atom<string>('')
export const requestLogStatusFilterAtom = atom<string>('')

// ── Match Lab ──────────────────────────────────────────────────────────────
export const matchLabActiveTabAtom = atom<string>('playground')
export const matchAnalyticsWindowHoursAtom = atom<number>(24 * 7)
