import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, LogOut, Monitor, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

/**
 * 我的设备 / 会话管理 — 列出当前账号在所有机器上的有效 session，
 * 允许「退出此设备外的全部」/ 单独踢某个 session。
 */
export function SessionsDialog({ open, onClose }: Props) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: api.auth.sessions,
    enabled: open,
    refetchOnWindowFocus: false,
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.auth.revokeSession(id),
    onSuccess: () => {
      toast.success('已踢下线')
      queryClient.invalidateQueries({ queryKey: ['my-sessions'] })
    },
    onError: (e: Error) => toast.error(`操作失败：${e.message}`),
  })

  const sessions = data ?? []
  const others = sessions.filter((s) => !s.is_current)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">我的登录设备</DialogTitle>
          <DialogDescription className="text-[11.5px] text-foreground/55">
            一台设备一行；丢失了某台机器、或怀疑账号被盗用，可以一键踢下线。
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 flex items-center justify-center text-foreground/40">
            <Loader2 size={14} className="animate-spin mr-2" /> 加载中…
          </div>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3',
                  s.is_current
                    ? 'border-accent/40 bg-accent/[0.04]'
                    : 'border-foreground/8 bg-foreground/[0.02]',
                )}
              >
                <Monitor size={16} className="text-foreground/55 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground/85">
                    {s.device_label || s.user_agent?.slice(0, 40) || '未知设备'}
                    {s.is_current && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-foreground/55 mt-0.5 space-y-0.5">
                    {s.ip && <div>IP {s.ip}</div>}
                    {s.created_at && (
                      <div>登录于 {new Date(s.created_at).toLocaleString('zh-CN')}</div>
                    )}
                    {s.expires_at && (
                      <div className="text-foreground/35">到期 {new Date(s.expires_at).toLocaleString('zh-CN')}</div>
                    )}
                  </div>
                </div>
                {!s.is_current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeMutation.mutate(s.id)}
                    disabled={revokeMutation.isPending}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                  >
                    <Trash2 size={12} className="mr-1" /> 踢下线
                  </Button>
                )}
              </div>
            ))}

            {others.length > 1 && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  for (const s of others) {
                    try { await api.auth.revokeSession(s.id) } catch { /* skip */ }
                  }
                  queryClient.invalidateQueries({ queryKey: ['my-sessions'] })
                  toast.success(`已踢下线 ${others.length} 台设备`)
                }}
                className="w-full mt-2"
              >
                <LogOut size={12} className="mr-1.5" />
                踢下其它 {others.length} 台设备
              </Button>
            )}

            {sessions.length === 0 && (
              <div className="py-8 text-center text-[12px] text-foreground/40">
                没有有效会话（不应该出现，可能 token 已过期）
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
