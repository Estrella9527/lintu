import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Eye, EyeOff, Loader2, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/**
 * 云端同步凭据配置 Dialog — 让 dev / ops flavor 用户在 UI 里配 sync URL + token，
 * 不用每次启动 Electron 前 export shell env。
 *
 * 凭据走 OS keychain 加密存储（main 进程 safeStorage），renderer 这边永远拿不到
 * 明文 token —— get 接口只回传 `token_set: bool`，让 UI 显示 "已设置 ****"。
 *
 * 保存后调 sidecar:restart 让新 env 立刻生效，避免用户手动 kill 进程。
 */

interface Props {
  open: boolean
  onClose: () => void
}

export function CloudSyncCredsDialog({ open, onClose }: Props) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [hasExisting, setHasExisting] = useState(false)
  const [busy, setBusy] = useState<'idle' | 'loading' | 'saving' | 'restarting' | 'clearing'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setBusy('loading')
    setError(null)
    setTokenRevealed(false)
    const api = (window as any).updaterAPI
    api?.cloudSyncCreds?.get()
      .then((res: any) => {
        setUrl(res?.url ?? '')
        setHasExisting(!!res?.has_creds)
        setToken('')   // 永远不预填 — 安全 + 强制用户主动改
        setBusy('idle')
      })
      .catch((e: any) => {
        setError(e?.message || '加载失败')
        setBusy('idle')
      })
  }, [open])

  const handleSave = async () => {
    if (!url.trim() || !token.trim()) {
      setError('URL 和 token 都必填')
      return
    }
    setError(null)
    setBusy('saving')
    const api = (window as any).updaterAPI
    const result = await api?.cloudSyncCreds?.set(url.trim(), token.trim())
    if (!result?.ok) {
      const reasonMsg: Record<string, string> = {
        user_flavor_locked: '用户版应用不允许配置云端同步凭据',
        invalid_payload:    'URL 或 token 不能为空',
        write_failed:       '保存到 OS keychain 失败 — 检查系统钥匙串权限',
      }
      setError(reasonMsg[result?.reason as string] || '保存失败')
      setBusy('idle')
      return
    }

    setBusy('restarting')
    const restart = await api?.restartSidecar()
    setBusy('idle')
    if (restart?.ok) {
      toast.success('凭据已保存 — sidecar 已重启，云同步立刻生效')
      // 让 sync-status 立即重拉，UI 顶部状态条带变绿
      queryClient.invalidateQueries({ queryKey: ['sync-status'] })
      onClose()
    } else {
      toast.error('凭据已存，但 sidecar 重启失败 — 请手动关闭并重启 Electron')
      setError(restart?.error || '重启失败')
    }
  }

  const handleClear = async () => {
    if (!confirm('确认清除已保存的云端同步凭据？保存后将不再同步到 UGC。')) return
    setBusy('clearing')
    setError(null)
    const api = (window as any).updaterAPI
    await api?.cloudSyncCreds?.clear()
    await api?.restartSidecar()
    setBusy('idle')
    setUrl('')
    setToken('')
    setHasExisting(false)
    queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    toast.success('已清除凭据；sidecar 重启后回到只本地模式')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>配置云端同步凭据</DialogTitle>
          <DialogDescription>
            填好后保存，sidecar 自动重启即生效。凭据加密存在 OS keychain 里，永远不会出现在 git 或日志。
            <br />
            <span className="text-amber-600">⚠ 配了之后，本机改匹配策略 / 同义词等会立刻同步到线上 UGC。</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-url" className="text-[12px]">云端 sidecar URL</Label>
            <Input
              id="cs-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://lintuapi.your-domain.com"
              className="text-[12.5px]"
              disabled={busy !== 'idle' && busy !== 'loading'}
            />
            <p className="text-[10.5px] text-foreground/45">
              内部 / open-api 都走这个 host。例：
              <code className="ml-1 bg-foreground/[0.04] rounded px-1">https://api.example.com</code>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cs-token" className="text-[12px]">
              Internal Sync Token
              {hasExisting && !token && (
                <span className="ml-2 text-[10.5px] text-foreground/45">已设置 · 输入新值即覆盖</span>
              )}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="cs-token"
                type={tokenRevealed ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={hasExisting ? '••••••（保持不变请清空提交则改其它字段）' : '复制 ECS .env 里 LINTU_INTERNAL_SYNC_TOKEN 的值'}
                className="text-[12.5px] flex-1"
                disabled={busy !== 'idle' && busy !== 'loading'}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setTokenRevealed((v) => !v)}
                title={tokenRevealed ? '隐藏' : '显示'}
              >
                {tokenRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
              </Button>
            </div>
          </div>

          {error && (
            <div className="text-[12px] text-destructive flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 sm:justify-between">
          <div>
            {hasExisting && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClear}
                disabled={busy !== 'idle'}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 size={12} className="mr-1.5" />
                清除并断开
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy === 'saving' || busy === 'restarting'}>
              取消
            </Button>
            <Button size="sm" onClick={handleSave} disabled={busy !== 'idle' || !url.trim() || !token.trim()}>
              {(busy === 'saving' || busy === 'restarting') && (
                <Loader2 size={12} className="animate-spin mr-1.5" />
              )}
              {busy === 'restarting' ? '重启 sidecar…' : busy === 'saving' ? '保存中…' : '保存并重启'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
