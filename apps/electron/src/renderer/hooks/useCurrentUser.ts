import { useAtomValue } from 'jotai'

import { currentUserAtom, type CurrentUser } from '@/atoms/auth'

/** 获取当前登录 user。未登录返回 null（理论上 AuthGate 不会让你看到 null）。 */
export function useCurrentUser(): CurrentUser | null {
  return useAtomValue(currentUserAtom)
}
