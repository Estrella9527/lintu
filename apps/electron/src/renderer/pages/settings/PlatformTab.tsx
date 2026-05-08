import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, ImageIcon, ShieldCheck, Users } from 'lucide-react'

import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { api } from '@/lib/api'
import { CreateOrgDialog } from '@/components/app-shell/CreateOrgDialog'
import { cn } from '@/lib/utils'

const PLAN_TONE: Record<string, string> = {
  free: 'bg-foreground/8 text-foreground/65',
  pro: 'bg-accent/15 text-accent',
  enterprise: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
}

/** 设置 → 平台管理 — 仅 platform owner 可见。 */
export function PlatformTab() {
  const user = useCurrentUser()
  const [showCreate, setShowCreate] = useState(false)
  const [tab, setTab] = useState<'orgs' | 'users'>('orgs')

  const { data: overview } = useQuery({
    queryKey: ['platform-overview'],
    queryFn: api.platform.overview,
    enabled: !!user?.is_platform_owner,
    refetchInterval: 60_000,
  })

  const { data: orgs } = useQuery({
    queryKey: ['platform-orgs'],
    queryFn: api.platform.listOrgs,
    enabled: !!user?.is_platform_owner && tab === 'orgs',
  })

  const { data: users } = useQuery({
    queryKey: ['platform-users'],
    queryFn: api.platform.listUsers,
    enabled: !!user?.is_platform_owner && tab === 'users',
  })

  if (!user?.is_platform_owner) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={ShieldCheck}
          title="仅平台超级管理员可访问"
          description="平台管理页面是给龙蟾科技超管运维用的，组织内的 owner 看不到"
        />
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-4xl">
      {/* 概览卡片 */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon={Building2} label="组织" value={overview?.org_count ?? 0} />
        <StatCard icon={Users} label="用户" value={overview?.user_count ?? 0} />
        <StatCard icon={Building2} label="项目" value={overview?.project_count ?? 0} />
        <StatCard icon={ImageIcon} label="图片" value={overview?.image_count ?? 0} />
      </div>

      {/* Tab */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-foreground/[0.04] p-0.5">
          <button
            onClick={() => setTab('orgs')}
            className={cn(
              'px-3 py-1 rounded text-[12px] transition-colors',
              tab === 'orgs' ? 'bg-background shadow-sm font-medium' : 'text-foreground/65',
            )}
          >组织</button>
          <button
            onClick={() => setTab('users')}
            className={cn(
              'px-3 py-1 rounded text-[12px] transition-colors',
              tab === 'users' ? 'bg-background shadow-sm font-medium' : 'text-foreground/65',
            )}
          >用户</button>
        </div>
        {tab === 'orgs' && (
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Building2 size={12} className="mr-1.5" /> 新建组织
          </Button>
        )}
      </div>

      {/* 组织列表 */}
      {tab === 'orgs' && (
        <div className="space-y-1.5">
          {!orgs?.length && <EmptyState icon={Building2} title="还没有组织" description="点上方「新建组织」开始" />}
          {orgs?.map((o) => (
            <div
              key={o.id}
              className="rounded-md border border-foreground/5 px-3 py-2 hover:bg-foreground/[0.02] transition-colors flex items-center gap-3"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-gradient-to-br from-accent/60 to-accent/30 text-background">
                <Building2 size={13} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-foreground/85 truncate">
                  {o.name}
                  <code className="ml-2 text-[10.5px] text-foreground/40 font-mono">/{o.slug}</code>
                </div>
                <div className="text-[10.5px] text-foreground/55 tabular-nums">
                  {o.member_count} 成员 · {o.project_count} 项目 · 存储 {o.storage_used_gb.toFixed(1)} / {o.storage_quota_gb} GB
                </div>
              </div>
              <Badge className={cn('text-[10px] px-1.5 py-0 font-normal', PLAN_TONE[o.plan] || '')}>
                {o.plan}
              </Badge>
              <Badge
                className={cn(
                  'text-[10px] px-1.5 py-0 font-normal',
                  o.status === 'active'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
                )}
              >
                {o.status}
              </Badge>
            </div>
          ))}
        </div>
      )}

      {/* 用户列表 */}
      {tab === 'users' && (
        <div className="space-y-1.5">
          {!users?.length && <EmptyState icon={Users} title="还没有用户" description="" />}
          {users?.map((u) => (
            <div
              key={u.id}
              className="rounded-md border border-foreground/5 px-3 py-2 flex items-center gap-3"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/5 text-foreground/65 text-[11px]">
                {(u.display_name || u.phone || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-foreground/85 truncate">
                  {u.display_name || u.phone || '未命名'}
                  {u.is_platform_owner && (
                    <Badge className="ml-2 text-[9px] px-1 py-0 bg-amber-500/15 text-amber-700 dark:text-amber-400 font-normal">
                      平台超管
                    </Badge>
                  )}
                </div>
                <div className="text-[10.5px] text-foreground/55 tabular-nums">
                  {u.phone} · 注册 {u.created_at && new Date(u.created_at).toLocaleDateString('zh-CN')}
                  {u.last_login_at && (
                    <span className="text-foreground/35 ml-1">
                      · 末次登录 {new Date(u.last_login_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>
              </div>
              <Badge className={cn(
                'text-[10px] px-1.5 py-0 font-normal',
                u.status === 'active' ? 'bg-foreground/8 text-foreground/65' : 'bg-rose-500/15 text-rose-700',
              )}>
                {u.status}
              </Badge>
            </div>
          ))}
        </div>
      )}

      <CreateOrgDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  )
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-foreground/55">
        <Icon size={12} /> {label}
      </div>
      <div className="text-[18px] font-semibold tabular-nums text-foreground/90 mt-0.5">
        {value.toLocaleString()}
      </div>
    </div>
  )
}
