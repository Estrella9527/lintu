import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Loader2, MoreVertical, Send, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/shared/EmptyState'
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import { activeOrgAtom } from '@/atoms/auth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'

const PHONE_OK = /^1[3-9]\d{9}$/

const ROLE_LABEL: Record<string, string> = {
  owner: '组织主',
  admin: '管理员',
  member: '成员',
}
const ROLE_TONE: Record<string, string> = {
  owner: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  admin: 'bg-accent/15 text-accent',
  member: 'bg-foreground/8 text-foreground/65',
}

/** 设置 → 组织成员 */
export function OrgMembersTab() {
  const activeOrg = useAtomValue(activeOrgAtom)
  const user = useCurrentUser()
  const queryClient = useQueryClient()

  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')

  const canManage = !!user?.is_platform_owner ||
    activeOrg?.my_role === 'owner' ||
    activeOrg?.my_role === 'admin'

  const { data: members, isLoading } = useQuery({
    queryKey: ['org-members', activeOrg?.id],
    queryFn: () => api.orgs.listMembers(activeOrg!.id),
    enabled: !!activeOrg,
  })

  const addMutation = useMutation({
    mutationFn: (p: string) => api.orgs.addMember(activeOrg!.id, { phone: p, role }),
    onSuccess: (data) => {
      if ((data as any).already_member) {
        toast(`${phone} 已是成员`)
      } else {
        toast.success(`已加入 ${phone}（角色：${ROLE_LABEL[role]}）`)
      }
      setPhone('')
      queryClient.invalidateQueries({ queryKey: ['org-members'] })
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`添加失败：${msg}`)
    },
  })

  const updateRoleMutation = useMutation({
    mutationFn: ({ uid, r }: { uid: string; r: string }) =>
      api.orgs.updateMember(activeOrg!.id, uid, r),
    onSuccess: () => {
      toast.success('角色已更新')
      queryClient.invalidateQueries({ queryKey: ['org-members'] })
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`更新失败：${msg}`)
    },
  })

  const removeMutation = useMutation({
    mutationFn: (uid: string) => api.orgs.removeMember(activeOrg!.id, uid),
    onSuccess: () => {
      toast.success('已移出组织')
      queryClient.invalidateQueries({ queryKey: ['org-members'] })
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`移出失败：${msg}`)
    },
  })

  if (!activeOrg) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={Building2}
          title="未选择组织"
          description="先在左下角切换组织"
        />
      </div>
    )
  }

  if (!canManage) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={ShieldCheck}
          title="只有 owner / admin 可管理成员"
          description="你的角色是「成员」，能看到列表但不能添加 / 移除"
        />
      </div>
    )
  }

  const phoneValid = PHONE_OK.test(phone)
  const rows = members ?? []

  return (
    <div className="space-y-5 max-w-3xl">
      {/* 添加成员 */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[13px] font-medium text-foreground/85">添加成员</h3>
          <InfoHint text={
            '手机号未注册时会自动创建账号；该手机号下次用灵图登录即进入本组织。\n' +
            'owner / admin 自动获得本组织所有项目的 project_admin 权限，无需到每个项目单独加。'
          } />
        </div>
        <div className="flex gap-2">
          <span className="inline-flex items-center px-3 h-9 rounded-md border border-foreground/15 bg-foreground/[0.02] text-[12px] text-foreground/55 shrink-0">
            +86
          </span>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            onKeyDown={(e) => { if (e.key === 'Enter' && phoneValid) addMutation.mutate(phone) }}
            placeholder="138 1234 5678"
            disabled={addMutation.isPending}
            className="flex-1 h-9 text-[12.5px] tabular-nums"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
            disabled={addMutation.isPending}
            className="h-9 px-2 rounded-md border border-foreground/15 bg-background text-[12px]"
          >
            <option value="member">成员</option>
            <option value="admin">管理员</option>
          </select>
          <Button
            onClick={() => addMutation.mutate(phone)}
            disabled={!phoneValid || addMutation.isPending}
          >
            {addMutation.isPending
              ? <Loader2 size={12} className="animate-spin mr-1.5" />
              : <Send size={12} className="mr-1.5" />}
            添加
          </Button>
        </div>
      </section>

      {/* 成员列表 */}
      <section>
        <h3 className="text-[13px] font-medium text-foreground/85 mb-2">
          成员（{rows.length}）
        </h3>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-md bg-foreground/[0.02] animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={UserPlus} title="还没有成员" description="上方输入手机号添加" />
        ) : (
          <div className="space-y-1.5">
            {rows.map((m) => {
              const isMe = m.user_id === user?.id
              const canEdit = canManage && !isMe && m.role !== 'owner'
              return (
                <div
                  key={m.id}
                  className="flex items-center gap-3 rounded-md border border-foreground/5 px-3 py-2 hover:bg-foreground/[0.02] transition-colors"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-foreground/55 text-[11px]">
                    {(m.display_name || m.phone || '?').slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-foreground/85 truncate">
                      {m.display_name || m.phone || '未命名'}
                      {isMe && <span className="ml-1.5 text-[10px] text-foreground/45">（你）</span>}
                    </div>
                    <div className="text-[10.5px] text-foreground/55 tabular-nums truncate">
                      {m.phone}
                      {m.created_at && (
                        <span className="text-foreground/35 ml-2">
                          · 入组 {new Date(m.created_at).toLocaleDateString('zh-CN')}
                        </span>
                      )}
                    </div>
                  </div>
                  <Badge className={cn('text-[10px] px-1.5 py-0 shrink-0 font-normal', ROLE_TONE[m.role] ?? '')}>
                    {ROLE_LABEL[m.role] || m.role}
                  </Badge>
                  {canEdit && (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                          <MoreVertical size={12} />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-44 p-1">
                        {m.role !== 'admin' && (
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => updateRoleMutation.mutate({ uid: m.user_id, r: 'admin' })}
                            className="w-full justify-start text-[12px]"
                          >
                            升为管理员
                          </Button>
                        )}
                        {m.role !== 'member' && (
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => updateRoleMutation.mutate({ uid: m.user_id, r: 'member' })}
                            className="w-full justify-start text-[12px]"
                          >
                            降为成员
                          </Button>
                        )}
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => {
                            if (confirm(`确认把 ${m.phone} 移出组织？\n他在本组织所有项目的成员关系也会一并删除。`)) {
                              removeMutation.mutate(m.user_id)
                            }
                          }}
                          className="w-full justify-start text-[12px] text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 size={11} className="mr-1.5" /> 移出组织
                        </Button>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
