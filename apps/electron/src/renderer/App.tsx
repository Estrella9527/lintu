import { useEffect, useRef, useState } from 'react'
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
