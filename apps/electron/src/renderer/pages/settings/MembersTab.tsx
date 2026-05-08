import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Send, Trash2, UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/shared/EmptyState'
import { ApiError, getAuthToken , apiFetchRaw } from '@/lib/api'
import { InfoHint } from '@/components/shared/InfoHint'
import { activeProjectIdAtom } from '@/atoms/project'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn } from '@/lib/utils'

const API_BASE = 'http://127.0.0.1:7879/api'
const PHONE_REGEX = /^1[3-9]\d{9}$/

interface InvitationRow {
  id: string
  phone: string
  role: string
  expires_at: string | null
  accepted_at: string | null
  created_at: string | null
  invited_by: string | null
  status: 'pending' | 'accepted' | 'expired'
}

/**
 * 设置→成员管理 — Phase 1 仅 root 可邀请，UI 也按这个边界呈现：
 *   - 非 root 看到一句话提示「Phase 2 拆分 admin 角色后开放」
 *   - root 看到：当前项目的邀请列表 + 输入手机号发邀请 + 撤销 pending
 */
export function MembersTab() {
  const user = useCurrentUser()
  const projectId = useAtomValue(activeProjectIdAtom)

  if (!user?.is_root) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={UserPlus}
          title="仅超级管理员可邀请成员"
          description="后续会拆分 admin / operator 角色，开放给项目管理员"
        />
      </div>
    )
  }

  if (!projectId) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={UserPlus}
          title="未选择项目"
          description="先在左下角项目下拉选择一个项目，再来邀请成员"
        />
      </div>
    )
  }

  return <MembersTabBody projectId={projectId} />
}

function MembersTabBody({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [phone, setPhone] = useState('')

  const listQuery = useQuery<InvitationRow[]>({
    queryKey: ['invitations', projectId],
    queryFn: () =>
      apiFetchRaw(`/projects/${projectId}/invitations`, {
        headers: authHeader(),
      }).then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const createMutation = useMutation({
    mutationFn: async (p: string) => {
      const res = await apiFetchRaw(`/projects/${projectId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ phone: p, role: 'member' }),
      })
      const json = await res.json()
      if (!res.ok) {
        throw new ApiError(res.status, json, json?.detail?.message || `HTTP ${res.status}`)
      }
      return json
    },
    onSuccess: (data) => {
      if (data?.already_member) {
        toast(`${phone} 已是项目成员，无需重复邀请`)
      } else {
        toast.success(`已邀请 ${phone}，对方下次用此手机号登录灵图即自动加入`)
      }
      setPhone('')
      queryClient.invalidateQueries({ queryKey: ['invitations', projectId] })
    },
    onError: (e: Error) => toast.error(`邀请失败：${e.message}`),
  })

  const revokeMutation = useMutation({
    mutationFn: async (invId: string) => {
      const res = await apiFetchRaw(`/projects/${projectId}/invitations/${invId}`, {
        method: 'DELETE',
        headers: authHeader(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    onSuccess: () => {
      toast.success('邀请已撤销')
      queryClient.invalidateQueries({ queryKey: ['invitations', projectId] })
    },
    onError: (e: Error) => toast.error(`撤销失败：${e.message}`),
  })

  const phoneValid = PHONE_REGEX.test(phone)

  const handleInvite = () => {
    if (!phoneValid) {
      toast.error('请输入正确的手机号')
      return
    }
    createMutation.mutate(phone)
  }

  const rows = listQuery.data ?? []
  const pending = rows.filter((r) => r.status === 'pending')
  const accepted = rows.filter((r) => r.status === 'accepted')
  const expired  = rows.filter((r) => r.status === 'expired')

  return (
    <div className="space-y-6 max-w-2xl">
      {/* 创建邀请 */}
      <section>
        <div className="flex items-center gap-1.5 mb-2">
          <h3 className="text-[13px] font-medium text-foreground/80">新增邀请</h3>
          <InfoHint text={
            '输入手机号写入邀请记录。被邀请人下次用同一手机号登录灵图时自动加入此项目；不发额外短信。\n' +
            '7 天内有效，可提前撤销。'
          } />
        </div>
        <div className="flex gap-2">
          <span className="inline-flex items-center px-3 h-9 rounded-md border border-foreground/15 bg-foreground/[0.02] text-[12px] text-foreground/55 shrink-0">
            +86
          </span>
          <Input
            type="tel"
            value={phone}
            placeholder="138 1234 5678"
            onChange={(e) => setPhone(e.target.value.replace(/\s/g, '').slice(0, 11))}
            onKeyDown={(e) => { if (e.key === 'Enter' && phoneValid) handleInvite() }}
            className="flex-1 text-[12.5px]"
            disabled={createMutation.isPending}
          />
          <Button
            onClick={handleInvite}
            disabled={!phoneValid || createMutation.isPending}
            className="shrink-0"
          >
            {createMutation.isPending ? (
              <Loader2 size={12} className="animate-spin mr-1.5" />
            ) : (
              <Send size={12} className="mr-1.5" />
            )}
            发邀请
          </Button>
        </div>
      </section>

      {/* 待接受 */}
      <Section title={`待接受 (${pending.length})`} hint="对方还没登录灵图。撤销后该手机号将无法自动加入。">
        <InvitationList
          rows={pending}
          onRevoke={(id) => revokeMutation.mutate(id)}
          revokeLoading={revokeMutation.isPending}
        />
      </Section>

      {/* 已加入 */}
      <Section title={`已加入 (${accepted.length})`}>
        <InvitationList rows={accepted} />
      </Section>

      {/* 过期 */}
      {expired.length > 0 && (
        <Section title={`已过期 / 撤销 (${expired.length})`}>
          <InvitationList rows={expired.slice(0, 10)} />
        </Section>
      )}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-2">
        <h3 className="text-[13px] font-medium text-foreground/80">{title}</h3>
        {hint && <InfoHint text={hint} />}
      </div>
      {children}
    </section>
  )
}

function InvitationList({
  rows, onRevoke, revokeLoading,
}: {
  rows: InvitationRow[]
  onRevoke?: (id: string) => void
  revokeLoading?: boolean
}) {
  if (rows.length === 0) {
    return <div className="text-[11.5px] text-foreground/40 px-1">—</div>
  }
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div
          key={r.id}
          className={cn(
            'flex items-center gap-3 px-3 py-2 rounded-md border text-[12px]',
            r.status === 'pending'  && 'border-amber-500/30 bg-amber-500/[0.04]',
            r.status === 'accepted' && 'border-emerald-500/30 bg-emerald-500/[0.04]',
            r.status === 'expired'  && 'border-foreground/10 bg-foreground/[0.02] opacity-70',
          )}
        >
          <div className="font-mono text-foreground/85 w-32 shrink-0">{r.phone}</div>
          <div className="text-[11px] text-foreground/55 flex-1">
            {r.status === 'pending'  && `${fmtRel(r.created_at)} 发出 · ${fmtRel(r.expires_at)} 过期`}
            {r.status === 'accepted' && `${fmtRel(r.accepted_at)} 已加入`}
            {r.status === 'expired'  && `已过期`}
          </div>
          {onRevoke && r.status === 'pending' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRevoke(r.id)}
              disabled={revokeLoading}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={11} className="mr-1" />
              撤销
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────


function authHeader(): Record<string, string> {
  // App.tsx 启动时调过 hydrateAuthToken()，所以 getAuthToken 同步可读。
  // 这里用原生 fetch 是因为邀请端点是 PR-7 临时加的，没在 api 客户端封装；
  // 后续 PR-8 收口时可以挪到 api.invitations.* 。
  const t = getAuthToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const sec = Math.abs(Math.floor(diffMs / 1000))
  const future = diffMs < 0
  if (sec < 60)        return future ? '即将'   : '刚刚'
  if (sec < 3600)      return `${Math.floor(sec / 60)} 分钟${future ? '后' : '前'}`
  if (sec < 86400)     return `${Math.floor(sec / 3600)} 小时${future ? '后' : '前'}`
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} 天${future ? '后' : '前'}`
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
