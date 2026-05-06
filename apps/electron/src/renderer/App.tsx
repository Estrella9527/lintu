import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AppShell } from '@/components/app-shell/AppShell'
import '@/atoms/theme'

const API_BASE = 'http://localhost:7879'

export default function App() {
  const [ready, setReady] = useState(false)
  const checkedRef = useRef(false)

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

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="text-[15px] font-medium text-foreground/80">正在启动后台服务...</div>
          <div className="text-[12px] text-foreground/40">首次启动可能需要几秒钟</div>
        </div>
      </div>
    )
  }

  return <AppShell />
}
