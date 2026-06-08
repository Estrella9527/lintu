import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export interface CurrentUserProject {
  id: string
  name: string
  color: string | null
  role: string
}

export interface CurrentUser {
  id: string
  phone: string | null
  display_name: string | null
  avatar_url: string | null
  is_root: boolean
  is_platform_owner?: boolean
  projects: CurrentUserProject[]
}

export interface CurrentOrgSummary {
  id: string
  name: string
  slug: string
  logo_url: string | null
  contact_email: string | null
  plan: string
  status: string
  storage_quota_gb: number
  storage_used_gb: number
  member_count: number
  project_count: number
  /** 当前用户在这个组织的角色 — owner|admin|member|platform_owner */
  my_role: string | null
}

/** 当前激活组织 id — 跨重启持久化（每次启动会跟 /api/orgs 列表对齐）。 */
export const activeOrgIdAtom = atomWithStorage<string | null>('lintu-active-org', null, undefined, {
  getOnInit: true,
})

/** 「我所属的组织」列表 — 启动后第一次 /api/orgs 拿到后填进来。
 *  之后切组织时会单独 fetch；新建 / 改组织也会 invalidate。 */
export const myOrgsAtom = atom<CurrentOrgSummary[]>([])

/** 派生：当前组织对象（从 myOrgs + activeOrgId 计算）。 */
export const activeOrgAtom = atom((get) => {
  const id = get(activeOrgIdAtom)
  return get(myOrgsAtom).find((o) => o.id === id) ?? null
})

/** 当前登录用户 — null = 未登录。
 *  AuthGate 在 /api/auth/me 200 后 set；登出 / 401 时 set null。
 *
 *  不持久化：每次启动 App 都重新调 /me 校验 token，避免本地缓存与服务端 sessions
 *  不一致（如管理员撤销了 session）。token 自身在 main 进程 safeStorage 里。 */
export const currentUserAtom = atom<CurrentUser | null>(null)

/** Auth gate 状态：
 *   loading  — 启动期 /me 还没回；splash 显示
 *   guest    — 没 token 或 token 无效；显示 Login 页
 *   active   — 已登录；正常进 AppShell
 */
export type AuthState = 'loading' | 'guest' | 'active'
export const authStateAtom = atom<AuthState>('loading')
