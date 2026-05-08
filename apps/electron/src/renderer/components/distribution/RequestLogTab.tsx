import { apiFetchRaw } from '@/lib/api'
import { useEffect, useMemo } from 'react'
import { useAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'

import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { requestLogSelectedKeyAtom, requestLogStatusFilterAtom } from '@/atoms/ui-state'

const KEYS_API = '/api-keys'

interface ApiKey { id: string; key_id: string; name: string }

interface LogRow {
  id: number
  key_id: string | null
  method: string
  path: string
  status_code: number | null
  ip: string | null
  user_agent: string | null
  response_size: number | null
  latency_ms: number | null
  created_at: string
}

export function RequestLogTab({ initialKeyId }: { initialKeyId?: string } = {}) {
  const [selectedKey, setSelectedKey] = useAtom(requestLogSelectedKeyAtom)
  const [statusFilter, setStatusFilter] = useAtom(requestLogStatusFilterAtom)

  const { data: keys } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: () => apiFetchRaw(KEYS_API).then((r) => r.json()),
  })

  // Apply deep-link from ApiKeyTab — find the key by its public key_id
  // (URL-friendly identifier) and select it. Always overrides any current
  // atom value because the deep-link is an explicit user intent ("filter
  // logs to *this* key now"); we want it to win even if the user had
  // previously selected another key in this session.
  useEffect(() => {
    if (!initialKeyId || !keys?.length) return
    const k = keys.find((it) => it.key_id === initialKeyId || it.id === initialKeyId)
    if (k && k.id !== selectedKey) setSelectedKey(k.id)
  }, [initialKeyId, keys, selectedKey, setSelectedKey])

  const keyById = useMemo(() => {
    const m = new Map<string, ApiKey>()
    keys?.forEach((k) => m.set(k.id, k))
    return m
  }, [keys])

  const { data: logs } = useQuery<LogRow[]>({
    queryKey: ['api-logs', selectedKey, statusFilter],
    queryFn: async () => {
      if (!selectedKey) return []
      const qs = new URLSearchParams({ limit: '200' })
      if (statusFilter) qs.set('status_code', statusFilter)
      const res = await apiFetchRaw(`${KEYS_API}/${selectedKey}/logs?${qs}`)
      if (!res.ok) return []
      return res.json()
    },
    enabled: !!selectedKey,
    refetchInterval: 5000,
  })

  return (
    <div className="space-y-3 max-w-4xl">
      <div className="flex items-center gap-2">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className="h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px] min-w-[220px]"
        >
          <option value="">— 选择 API Key 查看日志 —</option>
          {keys?.map((k) => (
            <option key={k.id} value={k.id}>{k.name} ({k.key_id})</option>
          ))}
        </select>
        <Input
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="状态码筛选 (可选)"
          className="h-8 w-44 text-[12px]"
        />
        <span className="text-[11px] text-foreground/40 ml-auto">
          {logs?.length ?? 0} 条记录 · 5s 自动刷新
        </span>
      </div>

      {!selectedKey ? (
        <div className="rounded-lg border border-dashed border-foreground/10 py-12 text-center text-[13px] text-foreground/40">
          先选一个 API Key 查看其调用日志
        </div>
      ) : !logs?.length ? (
        <div className="rounded-lg border border-dashed border-foreground/10 py-12 text-center text-[13px] text-foreground/40">
          这个 Key 还没有调用记录
        </div>
      ) : (
        <div className="rounded-md border border-foreground/10 overflow-hidden">
          <table className="w-full text-[11px]">
            <thead className="bg-foreground/[0.03] text-foreground/55">
              <tr>
                <th className="px-3 py-2 text-left">时间</th>
                <th className="px-3 py-2 text-left">方法</th>
                <th className="px-3 py-2 text-left">路径</th>
                <th className="px-3 py-2 text-right">状态</th>
                <th className="px-3 py-2 text-right">延迟</th>
                <th className="px-3 py-2 text-right">大小</th>
                <th className="px-3 py-2 text-left">来源</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/5">
              {logs.map((row) => (
                <tr key={row.id} className="hover:bg-foreground/[0.02]">
                  <td className="px-3 py-1.5 text-foreground/55 tabular-nums">
                    {new Date(row.created_at).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 font-mono">
                      {row.method}
                    </Badge>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-foreground/75 truncate max-w-[280px]">
                    {row.path}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    <span className={
                      row.status_code == null ? 'text-foreground/40' :
                      row.status_code >= 500 ? 'text-destructive' :
                      row.status_code >= 400 ? 'text-warning' :
                      row.status_code >= 300 ? 'text-info' :
                      'text-success'
                    }>
                      {row.status_code ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-foreground/55 tabular-nums">
                    {row.latency_ms != null ? `${row.latency_ms}ms` : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-foreground/55 tabular-nums">
                    {row.response_size != null && row.response_size > 0 ? formatBytes(row.response_size) : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-foreground/45 truncate max-w-[140px]" title={row.ip || ''}>
                    {row.ip ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
