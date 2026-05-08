import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Clock, Cloud, Monitor, Terminal } from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 「最近修改」时间线 — 按时间倒序展示 config 变更，主要解决多人协作时
 * 「谁改了我的匹配策略」的追溯需求。
 *
 * 数据源：/api/config/audit-log
 *   - source = desktop / cloud_sync / cli
 *   - actor_meta 给出 host + pid，至少能定位到机器
 *
 * 默认折叠 — 大部分时候用户不关心；展开后展示最近 N 条。
 */

interface AuditEntry {
  id: number
  key: string
  old_value: unknown
  new_value: unknown
  source: 'desktop' | 'cloud_sync' | 'cli'
  actor_meta: { host?: string; pid?: number } | null
  created_at: string | null
}

interface Props {
  /** 默认拉「所有 key」；传具体 key 名只看那条 key 的历史 */
  filterKey?: string
  defaultOpen?: boolean
  className?: string
}

const SOURCE_META: Record<AuditEntry['source'], { label: string; icon: typeof Cloud; tone: string }> = {
  desktop:    { label: '桌面端',  icon: Monitor,  tone: 'text-foreground/65' },
  cloud_sync: { label: '云端同步', icon: Cloud,    tone: 'text-amber-600' },
  cli:        { label: 'CLI/脚本', icon: Terminal, tone: 'text-foreground/55' },
}

export function ConfigAuditTimeline({ filterKey, defaultOpen = false, className }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const { data, isLoading } = useQuery({
    queryKey: ['config-audit-log', filterKey],
    queryFn: () => api.config.auditLog({ key: filterKey, limit: 30 }),
    enabled: open,
    staleTime: 10_000,
  })

  return (
    <section className={cn('rounded-lg border border-foreground/5', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2 text-[12px]">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Clock size={12} className="text-foreground/55" />
          <span className="font-medium text-foreground/85">最近修改</span>
          {filterKey && (
            <span className="text-[10.5px] text-foreground/45 font-mono">
              {filterKey}
            </span>
          )}
        </div>
        <span className="text-[10.5px] text-foreground/40">{open ? '点击收起' : '点击展开'}</span>
      </button>

      {open && (
        <div className="border-t border-foreground/5 p-3">
          {isLoading ? (
            <div className="text-[12px] text-foreground/45">加载中…</div>
          ) : !data || data.length === 0 ? (
            <div className="text-[12px] text-foreground/40">还没有审计记录（或仅在落地本次改动后才会出现）</div>
          ) : (
            <ol className="space-y-2 max-h-[320px] overflow-y-auto">
              {data.map((e) => <AuditRow key={e.id} entry={e} />)}
            </ol>
          )}
        </div>
      )}
    </section>
  )
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const meta = SOURCE_META[entry.source] || SOURCE_META.desktop
  const Icon = meta.icon
  return (
    <li className="text-[11.5px] flex items-start gap-2 py-1 px-1.5 rounded hover:bg-foreground/[0.02]">
      <Icon size={11} className={cn('shrink-0 mt-0.5', meta.tone)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <code className="text-foreground/85 font-mono text-[11px] truncate">{entry.key}</code>
          <span className={cn('text-[10px]', meta.tone)}>{meta.label}</span>
          {entry.actor_meta?.host && (
            <span className="text-[10px] text-foreground/40 truncate">@{entry.actor_meta.host}</span>
          )}
          <span className="text-[10px] text-foreground/40 ml-auto shrink-0 tabular-nums">
            {fmtTime(entry.created_at)}
          </span>
        </div>
        <div className="mt-0.5 text-[10.5px] text-foreground/55 truncate">
          <span className="text-foreground/40">old:</span>
          <code className="ml-1 mr-2">{fmtValue(entry.old_value)}</code>
          <span className="text-foreground/40">→</span>
          <span className="text-foreground/40 ml-1">new:</span>
          <code className="ml-1 text-accent">{fmtValue(entry.new_value)}</code>
        </div>
      </div>
    </li>
  )
}

function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  if (today) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 36) + '…' : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // dict / list — 紧凑 JSON
  try {
    const s = JSON.stringify(v)
    return s.length > 60 ? s.slice(0, 56) + '…' : s
  } catch {
    return '?'
  }
}
