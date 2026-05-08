import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Cloud, CloudOff, Loader2, Lock, Settings as SettingsIcon } from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useBuildFlavor } from '@/hooks/useBuildFlavor'
import { cn } from '@/lib/utils'
import { CloudSyncCredsDialog } from './CloudSyncCredsDialog'

/**
 * 「保存会不会影响线上」的实时状态条 — 必须放在所有"保存即同步生产"语义的
 * 配置页面顶上。在分发版（外部下载用户）的桌面 sidecar 里，cloud sync 默认
 * 关闭，运营改的只是本地配置；只有配了 LINTU_CLOUD_SYNC_URL +
 * LINTU_INTERNAL_SYNC_TOKEN 的机器才会推到云端 UGC。
 *
 * UX 三态：
 *   - sync ON  绿色：明确写出「这台机器是生产管理者」+ 目标 URL
 *   - sync OFF 灰色：明确写「只本地生效，不会影响线上 UGC」
 *   - 端点失败  琥珀：sidecar 还没起 / 旧版没有这个端点
 */
export function SyncStatusBanner({ className }: { className?: string }) {
  const flavor = useBuildFlavor()
  const [credsOpen, setCredsOpen] = useState(false)

  // ⚠ Hooks 顺序：所有 hook 必须在条件返回之前调用。useBuildFlavor 是
  // 异步的（IPC 默认值 'user'，主进程返回后才变 'dev'），如果在它之后
  // 写 `if (flavor === 'user') return` 早返回，再去 useQuery → 跨渲染
  // 调用的 hook 数量不一致，触发 "Rendered more hooks than during the
  // previous render."（修复 2026-05-07）
  const { data, isLoading, isError } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.config.syncStatus(),
    refetchInterval: 30_000,
    // sidecar 启动期可能 404；静默重试，不要刷红
    retry: 1,
    // user 版不需要这个数据；hook 还是要调，但跳过实际请求
    enabled: flavor !== 'user',
  })

  // dev / ops 通用：右上角放一个「配置同步」按钮，让用户在 UI 里直接填
  // URL + token。点了打开 CloudSyncCredsDialog。
  const configBtn = flavor !== 'user' ? (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setCredsOpen(true)}
      className="h-6 text-[10.5px] shrink-0"
    >
      <SettingsIcon size={11} className="mr-1" />
      {data?.enabled ? '修改凭据' : '配置同步'}
    </Button>
  ) : null

  const credsDialog = flavor !== 'user' ? (
    <CloudSyncCredsDialog open={credsOpen} onClose={() => setCredsOpen(false)} />
  ) : null

  // user 版直接短路：UI 即使不查端点也能立刻给出"绝对不会改线上"的承诺。
  // 即使 sidecar 挂了 / 用户瞎设了 env，main 进程已经把 cloud sync 凭据剥了。
  if (flavor === 'user') {
    return (
      <Banner tone="local" className={className}>
        <Lock size={13} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground/85">
            用户版 — 改动<strong>绝对</strong>不会影响线上 UGC
          </div>
          <div className="text-[10.5px] text-foreground/55 mt-0.5">
            这台机器物理屏蔽了云端同步凭据；线上配置由运营版应用统一推送。
          </div>
        </div>
      </Banner>
    )
  }

  if (isLoading) {
    return (
      <Banner tone="muted" className={className}>
        <Loader2 size={13} className="animate-spin" />
        正在确认同步状态…
      </Banner>
    )
  }

  if (isError || !data) {
    return (
      <Banner tone="warning" className={className}>
        <AlertTriangle size={13} />
        无法确认同步状态 — 请检查 sidecar 是否在 7879 端口
      </Banner>
    )
  }

  if (data.enabled) {
    return (
      <>
        <Banner tone="online" className={className}>
          <Cloud size={13} />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground/85">
              ⚠ 这台机器是<strong className="text-amber-600">线上配置管理者</strong>
              ：保存会立即同步到 UGC 端
              {flavor === 'ops' && (
                <span className="ml-1.5 text-[10.5px] px-1 py-0.5 rounded bg-amber-500/15">运营版</span>
              )}
              {flavor === 'dev' && (
                <span className="ml-1.5 text-[10.5px] px-1 py-0.5 rounded bg-foreground/[0.08] text-foreground/65">开发模式</span>
              )}
            </div>
            <div className="text-[10.5px] text-foreground/55 truncate mt-0.5">
              目标：<code className="text-foreground/65">{data.target_url}</code>
              {data.pending_jobs > 0 && (
                <span className="ml-2 text-amber-600">· 当前 {data.pending_jobs} 条待同步</span>
              )}
            </div>
          </div>
          {configBtn}
        </Banner>
        {credsDialog}
      </>
    )
  }

  return (
    <>
      <Banner tone="local" className={className}>
        <CloudOff size={13} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground/85">
            只本地生效 — 改动<strong>不会</strong>影响线上 UGC
          </div>
          <div className="text-[10.5px] text-foreground/55 mt-0.5">
            {flavor === 'dev' || flavor === 'ops'
              ? '尚未配置云端同步凭据。点右侧「配置同步」填 URL + token，保存后立即生效。'
              : '这是普通桌面端的默认行为；线上配置由运营管理员的专用机器统一推送。'}
          </div>
        </div>
        {configBtn}
      </Banner>
      {credsDialog}
    </>
  )
}

type Tone = 'online' | 'local' | 'warning' | 'muted'

const TONE_STYLES: Record<Tone, string> = {
  online:  'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400',
  local:   'border-foreground/10 bg-foreground/[0.02] text-foreground/65',
  warning: 'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400',
  muted:   'border-foreground/8 bg-transparent text-foreground/45',
}

function Banner({
  tone,
  className,
  children,
}: {
  tone: Tone
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-[12px] flex items-start gap-2',
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </div>
  )
}
