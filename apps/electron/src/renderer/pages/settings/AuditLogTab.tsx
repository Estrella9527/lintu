import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, RefreshCw, ScrollText } from 'lucide-react'

import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'

const METHOD_TONE: Record<string, string> = {
  POST:   'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  PUT:    'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  PATCH:  'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  DELETE: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
}

/**
 * 设置 → 操作日志 — 全平台写操作的 timeline，仅超级管理员可看。
 *
 * 数据来源：OperationLogMiddleware 在每次写请求后写一行 operation_log。
 * 这里是简单的「最新 100 条 + 路径前缀过滤 + 重新加载」，没分页 / 无穷滚动 —
 * Phase 1 数据量小够用；Phase 2 看实际访问频率再决定加分页。
 */
export function AuditLogTab() {
  const user = useCurrentUser()
  const [pathFilter, setPathFilter] = useState('')

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['audit-operations', pathFilter],
    queryFn: () => api.audit.listOperations({
      path_prefix: pathFilter || undefined,
      limit: 100,
    }),
    enabled: !!user?.is_root,
    refetchInterval: 30_000,
  })

  if (!user?.is_root) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={ScrollText}
          title="仅超级管理员可查看操作日志"
          description="后续拆分项目管理员后，可能会按项目维度开放部分日志"
        />
      </div>
    )
  }

  const items = data?.items ?? []

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex items-center gap-2">
        <Input
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          placeholder="按路径前缀过滤，如 /api/projects"
          className="h-8 text-[12px] flex-1"
        />
        <InfoHint text="记录所有写操作（POST / PUT / PATCH / DELETE）。每行有操作人 / 时间 / 路径 / 状态码，用于事后追溯。读操作（GET）不记录。" />
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={12} className={cn('mr-1.5', isFetching && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 rounded-md bg-foreground/[0.02] animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Activity} title="暂无记录" description="还没有写操作，或当前过滤条件下没有匹配" />
      ) : (
        <div className="space-y-1">
          {items.map((row) => (
            <div
              key={row.id}
              className="rounded-md border border-foreground/5 px-3 py-2 hover:bg-foreground/[0.02] transition-colors"
            >
              <div className="flex items-center gap-2 text-[12px]">
                <Badge
                  className={cn(
                    'font-mono text-[10px] px-1.5 py-0 shrink-0',
                    METHOD_TONE[row.method] || 'bg-foreground/10 text-foreground/70',
                  )}
                >
                  {row.method}
                </Badge>
                <code className="text-[11.5px] text-foreground/85 truncate flex-1">{row.path}</code>
                {row.status_code != null && (
                  <span className={cn(
                    'text-[10.5px] tabular-nums shrink-0',
                    row.status_code >= 400 ? 'text-rose-600 dark:text-rose-400' : 'text-foreground/40',
                  )}>
                    {row.status_code}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1 text-[10.5px] text-foreground/50">
                <span>
                  {row.user
                    ? (row.user.display_name || row.user.phone || row.user_id?.slice(0, 8))
                    : <span className="italic text-foreground/30">系统/未登录</span>}
                </span>
                {row.project_id && <span className="text-foreground/35">· project {row.project_id.slice(0, 8)}</span>}
                {row.ip && <span className="text-foreground/35">· {row.ip}</span>}
                <span className="ml-auto text-foreground/40 tabular-nums">
                  {row.created_at && new Date(row.created_at).toLocaleString('zh-CN')}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
