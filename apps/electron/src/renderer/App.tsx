import { useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import { AppShell } from '@/components/app-shell/AppShell'
import LoginPage from '@/pages/Login'
import { ReleaseNotesModal } from '@/components/shared/ReleaseNotesModal'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'
import { useReleaseNotesPrompt } from '@/hooks/useReleaseNotesPrompt'
import { activeOrgIdAtom, authStateAtom, currentUserAtom, myOrgsAtom, type CurrentUser } from '@/atoms/auth'
import { ApiError, api, hydrateAuthToken, onAuthLoggedOut } from '@/lib/api'
import '@/atoms/theme'

const API_BASE = 'http://127.0.0.1:7879'

export default function App() {
  const [ready, setReady] = useState(false)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const checkedRef = useRef(false)
  const releaseNotes = useReleaseNotesPrompt(appVersion)
  const [authState, setAuthState] = useAtom(authStateAtom)
  const [, setCurrentUser] = useAtom(currentUserAtom)
  const [, setMyOrgs] = useAtom(myOrgsAtom)
  const [activeOrgId, setActiveOrgId] = useAtom(activeOrgIdAtom)
  const authCheckedRef = useRef(false)

  // 监听全局 401 → 重置到登录页
  useEffect(() => {
    return onAuthLoggedOut(() => {
      setCurrentUser(null)
      setAuthState('guest')
    })
  }, [setAuthState, setCurrentUser])

  // sidecar ready 后立刻校验 token / 拉 me
  useEffect(() => {
    if (!ready || authCheckedRef.current) return
    authCheckedRef.current = true
    let active = true
    ;(async () => {
      // 从 main 进程 safeStorage 读出 token 装进 api 客户端
      await hydrateAuthToken()
      try {
        const user = await api.auth.me()
        if (!active) return
        setCurrentUser(user)
        // 拉 我的组织列表，校准 active org
        try {
          const orgs = await api.orgs.list()
          if (!active) return
          setMyOrgs(orgs)
          // active 还有效就保留；否则跳到第一个 — 失效场景：组织被删 / 用户被踢
          const stillValid = activeOrgId && orgs.some((o) => o.id === activeOrgId)
          if (!stillValid) setActiveOrgId(orgs[0]?.id ?? null)
        } catch {
          setMyOrgs([])
        }
        setAuthState('active')
      } catch (e) {
        if (!active) return
        // 401 / 网络错误 → 视为未登录
        if (e instanceof ApiError && e.status === 401) {
          setAuthState('guest')
        } else {
          // sidecar 没起 / 端点 404（旧版）→ 暂时按未登录，让用户走登录流
          setAuthState('guest')
        }
      }
    })()
    return () => { active = false }
  }, [ready, setAuthState, setCurrentUser])

  const handleLoginSuccess = (user: CurrentUser) => {
    setCurrentUser(user)
    setAuthState('active')
  }

  // 后台滚动延期 — 每 6 小时调一次 /auth/refresh，让 30 天 session 永远不会到期
  // （只要用户每周开过应用一次）。后端也会记一次 last_login 但不换 token。
  // 失败静默：refresh 401 时 onAuthLoggedOut 已自动跳登录页。
  useEffect(() => {
    if (authState !== 'active') return
    const tick = () => { api.auth.refresh().catch(() => {}) }
    tick()  // 启动立刻续一次
    const id = setInterval(tick, 6 * 60 * 60 * 1000)  // 6h
    return () => clearInterval(id)
  }, [authState])

  useEffect(() => {
    if (checkedRef.current) return
    checkedRef.current = true

    let active = true
    ;(async () => {
      for (let i = 0; i < 50 && active; i++) {
        try {
          const res = await fetch(`${API_BASE}/health`)
          if (res.ok) { setReady(true); return }
        } catch {}
        await new Promise((r) => setTimeout(r, 300))
      }
    })()
    return () => { active = false }
  }, [])

  // Pull current version from updaterAPI; release-notes prompt waits on it.
  useEffect(() => {
    const api = (window as any).updaterAPI
    api?.getVersion?.().then((v: string) => setAppVersion(v))
  }, [])

  // Dev hot-reload feedback: when Electron main detects a sidecar source
  // change and restarts the python process, surface it as a toast so we
  // can tell "the request just failed because of a restart, not a real bug".
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.onSidecarLifecycle) return
    let restartingToastId: string | number | undefined
    const unsub = api.onSidecarLifecycle((event: 'restarting' | 'ready', payload: any) => {
      if (event === 'restarting') {
        restartingToastId = toast.loading('后端重启中…（检测到代码变更）')
      } else {
        if (restartingToastId !== undefined) {
          if (payload?.ok) {
            toast.success('后端已就绪', { id: restartingToastId, duration: 2000 })
          } else {
            toast.error('后端重启超时，请检查日志', { id: restartingToastId })
          }
          restartingToastId = undefined
        }
      }
    })
    return unsub
  }, [])

  // Auto-update toast. We only surface 'downloaded' (the actionable moment)
  // and 'error' if the check itself failed in a non-network-y way. Silent
  // on 'checking' / 'progress' / 'not-available' — users don't need to know
  // we're doing housekeeping in the background.
  useEffect(() => {
    const api = (window as any).updaterAPI
    if (!api?.on) return
    const unsubs = [
      api.on('downloaded', (info: { version?: string }) => {
        toast(`新版本 ${info?.version ? `v${info.version}` : ''} 已就绪`, {
          description: '重启应用即可使用最新版本（不重启也会在下次退出时自动更新）',
          duration: Infinity,
          action: {
            label: '立即重启',
            onClick: () => api.quitAndInstall(),
          },
        })
      }),
      api.on('error', (msg: string) => {
        // Quiet for transient network errors — the silent check will retry
        // on next launch. Only surface explicit signature/version failures.
        if (typeof msg === 'string' && /signature|verify|cert/i.test(msg)) {
          toast.error('更新失败：签名校验未通过', { description: msg })
        }
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])

  if (!ready || authState === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="text-[15px] font-medium text-foreground/80">正在启动后台服务...</div>
          <div className="text-[12px] text-foreground/40">首次启动可能需要几秒钟</div>
        </div>
      </div>
    )
  }

  if (authState === 'guest') {
    return <LoginPage onSuccess={handleLoginSuccess} appVersion={appVersion} />
  }

  return (
    <>
      <AppShell />
      <OnboardingFlow />
      <ReleaseNotesModal
        open={releaseNotes.open}
        onClose={releaseNotes.dismiss}
        releases={releaseNotes.releases}
        variant="first-launch"
      />
    </>
  )
}
