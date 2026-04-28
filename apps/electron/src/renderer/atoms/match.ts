import { atom } from 'jotai'

/** Cross-page hand-off: when set, AssetLibrary's MatchPlaygroundTab
 * pre-fills the query textarea with this string and (optionally) auto-runs.
 * Set by MatchAnalyticsTab's "在试匹配里复跑" link, by hard_queries
 * sample_text rows, etc. The consumer clears the atom after applying. */
export interface MatchPlaygroundSeed {
  text: string
  autoRun?: boolean
}
export const matchPlaygroundSeedAtom = atom<MatchPlaygroundSeed | null>(null)
