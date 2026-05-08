import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, RefreshCw, Sparkles, FileText, Compass, Cloud, Lock, Code } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ReleaseNotesModal } from '@/components/shared/ReleaseNotesModal'
import { onboardingForceOpenAtom } from '@/atoms/onboarding'
import { useBuildFlavor } from '@/hooks/useBuildFlavor'
import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'progress'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'up-to-date' }
  | { kind: 'error'; message: string }

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const FLAVOR_META: Record<'dev' | 'user' | 'ops', { label: string; icon: typeof Cloud; tone: string; desc: string }> = {
  dev:  { label: '开发模式',  icon: Code,  tone: 'text-foreground/55 bg-foreground/[0.05]', desc: '从源代码本地运行，不分发' },
  user: { label: '普通用户版', icon: Lock,  tone: 'text-emerald-700 bg-emerald-500/[0.08]', desc: '物理屏蔽云端同步凭据 — 改配置不会影响线上 UGC' },
  ops:  { label: '运营管理版', icon: Cloud, tone: 'text-amber-700 bg-amber-500/[0.10]',     desc: '可推送配置到云端 — 改匹配策略会立即同步线上 UGC' },
}

export function AboutTab() {
  const [version, setVersion] = useState<string>('')
  const [state, setState] = useState<CheckState>({ kind: 'idle' })
  const [notesOpen, setNotesOpen] = useState(false)
  const setForceOnboarding = useSetAtom(onboardingForceOpenAtom)
  const flavor = useBuildFlavor()
  const flavorMeta = FLAVOR_META[flavor]

  useEffect(() => {
    const api = (window as any).updaterAPI
    api?.getVersion?.().then(setVersion)
  }, [])

  // Subscribe to lifecycle so the manual check button reflects live status.
  // We get global toasts from App.tsx for 'downloaded' too — that's fine,
  // duplicate signal is harmless.
  useEffect(() => {
    const api = (window as any).updaterAPI
    if (!api?.on) return
    const subs = [
      api.on('checking', () => setState({ kind: 'checking' })),
      api.on('available', (info: { version: string }) =>
        setState({ kind: 'available', version: info.version }),
      ),
      api.on('not-available', () => setState({ kind: 'up-to-date' })),
      api.on('progress', (p: { percent: number; transferred: number; total: number }) =>
        setState({
          kind: 'progress',
          percent: p.percent ?? 0,
          transferred: p.transferred ?? 0,
          total: p.total ?? 0,
        }),
      ),
      api.on('downloaded', (info: { version: string }) =>
        setState({ kind: 'downloaded', version: info.version }),
      ),
      api.on('error', (msg: string) =>
        setState({ kind: 'error', message: typeof msg === 'string' ? msg : '未知错误' }),
      ),
    ]
    return () => subs.forEach((u: () => void) => u())
  }, [])

  async function handleCheck() {
    const api = (window as any).updaterAPI
    if (!api?.check) return
    setState({ kind: 'checking' })
    const result = await api.check()
    if (!result.ok) {
      // result.reason 'dev mode' is expected during development; treat it
      // softly so devs don't see scary red errors.
      if (result.reason === 'dev mode') {
        toast('开发模式下不检查更新')
        setState({ kind: 'idle' })
        return
      }
      setState({ kind: 'error', message: result.reason })
    }
    // The lifecycle listeners will update state from here on.
  }

  function handleRestart() {
    const api = (window as any).updaterAPI
    api?.quitAndInstall?.()
  }

  return (
    <div className="max-w-md space-y-6">
      <div>
        <h3 className="text-[15px] font-semibold text-foreground/85">灵图</h3>
      </div>

      <div className="space-y-1.5 text-[12px] text-foreground/55">
        <p>当前版本：<span className="font-mono text-foreground/85">{version || '加载中…'}</span></p>
        <p>技术栈：Electron + React + Tailwind + FastAPI</p>

        <div className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 mt-2', flavorMeta.tone)}>
          <flavorMeta.icon size={12} />
          <span className="text-[11.5px] font-medium">{flavorMeta.label}</span>
          <InfoHint text={flavorMeta.desc} size={11} />
        </div>
        <div className="flex items-center gap-4 mt-1.5">
          <button
            onClick={() => setNotesOpen(true)}
            className="inline-flex items-center gap-1 text-[12px] text-foreground/65 hover:text-foreground/85 transition-colors"
          >
            <FileText size={12} />
            查看更新历史
          </button>
          <button
            onClick={() => setForceOnboarding(true)}
            className="inline-flex items-center gap-1 text-[12px] text-foreground/65 hover:text-foreground/85 transition-colors"
          >
            <Compass size={12} />
            重新观看引导
          </button>
        </div>
      </div>

      <ReleaseNotesModal open={notesOpen} onClose={() => setNotesOpen(false)} variant="browse" />


      <div className="rounded-lg border border-foreground/10 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <h4 className="text-[13px] font-medium text-foreground/85">软件更新</h4>
            <InfoHint text="app 启动 10 秒后会在后台静默检查；也可点右侧「检查更新」立即检查。" />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheck}
            disabled={state.kind === 'checking' || state.kind === 'progress'}
          >
            {state.kind === 'checking' || state.kind === 'progress' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            <span className="ml-1.5">检查更新</span>
          </Button>
        </div>

        <div className="text-[12px]">
          {state.kind === 'idle' && (
            <p className="text-foreground/45">尚未检查 / 已是最新</p>
          )}
          {state.kind === 'checking' && <p className="text-foreground/55">正在检查…</p>}
          {state.kind === 'available' && (
            <p className="text-foreground/55">
              发现新版本 <span className="font-mono text-foreground/85">v{state.version}</span>，正在后台下载…
            </p>
          )}
          {state.kind === 'progress' && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-foreground/55">
                <span>下载中…</span>
                <span className="font-mono">
                  {fmtMB(state.transferred)} / {fmtMB(state.total)} ({state.percent.toFixed(0)}%)
                </span>
              </div>
              <div className="h-1 rounded-full bg-foreground/10 overflow-hidden">
                <div
                  className="h-full bg-foreground/55 transition-all"
                  style={{ width: `${state.percent}%` }}
                />
              </div>
            </div>
          )}
          {state.kind === 'downloaded' && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-foreground/85">
                <Sparkles size={14} />
                <span>v{state.version} 已就绪</span>
              </div>
              <Button size="sm" onClick={handleRestart}>立即重启</Button>
            </div>
          )}
          {state.kind === 'up-to-date' && (
            <div className="flex items-center gap-1.5 text-foreground/55">
              <CheckCircle2 size={14} />
              <span>已是最新版本</span>
            </div>
          )}
          {state.kind === 'error' && (
            <p className="text-red-500/85">检查失败：{state.message}</p>
          )}
        </div>
      </div>
    </div>
  )
}
