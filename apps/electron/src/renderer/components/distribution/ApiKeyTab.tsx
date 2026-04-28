import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Copy, History, Key, Plus, RotateCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { distributionNavRequestAtom } from '@/atoms/navigation'

const KEYS_API = 'http://localhost:7879/api/api-keys'

interface ApiKey {
  id: string
  key_id: string
  name: string
  client_type: string
  allowed_origins: string[] | null
  allowed_ips: string[] | null
  scopes: string[] | null
  rate_limit: { per_minute?: number; per_day?: number } | null
  expires_at: string | null
  is_active: boolean
  created_at: string
  last_used_at: string | null
}

interface CreatedKey extends ApiKey {
  secret: string
  secret_hint: string
}

export function ApiKeyTab() {
  const queryClient = useQueryClient()
  const setNavRequest = useSetAtom(distributionNavRequestAtom)
  const [showCreate, setShowCreate] = useState(false)
  const [createdKey, setCreatedKey] = useState<CreatedKey | null>(null)

  const { data: keys, isLoading } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: () => fetch(KEYS_API).then((r) => r.json()),
  })

  const rotate = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${KEYS_API}/${id}/rotate`, { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<CreatedKey>
    },
    onSuccess: (k) => { setCreatedKey(k); queryClient.invalidateQueries({ queryKey: ['api-keys'] }) },
    onError: (e: Error) => toast.error(e.message),
  })

  const deactivate = useMutation({
    mutationFn: (id: string) => fetch(`${KEYS_API}/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => { toast.success('已停用'); queryClient.invalidateQueries({ queryKey: ['api-keys'] }) },
  })

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-foreground/50">
          {(keys ?? []).length} 个 Key · 已停用的 Key 仍保留审计日志
        </div>
        <Button size="sm" className="text-[12px] h-8" onClick={() => setShowCreate(true)}>
          <Plus size={13} className="mr-1" /> 新建 API Key
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <div key={i} className="h-20 rounded-lg bg-foreground/[0.02] animate-pulse" />)}
        </div>
      ) : !keys?.length ? (
        <div className="text-center py-12 text-[13px] text-foreground/40 rounded-lg border border-dashed border-foreground/10">
          还没有 API Key。点击右上角创建一个。
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className="rounded-lg border border-foreground/8 p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Key size={12} className="text-foreground/40" />
                    <span className="text-[13px] font-medium text-foreground/85">{k.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1 py-0">{k.client_type}</Badge>
                    <Badge
                      variant="secondary"
                      className={`text-[10px] px-1 py-0 ${k.is_active ? 'bg-success/15 text-success' : 'bg-foreground/10 text-foreground/40'}`}
                    >
                      {k.is_active ? '激活' : '已停用'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-foreground/50 font-mono">
                    <code className="px-2 py-0.5 rounded bg-foreground/[0.04]">{k.key_id}</code>
                    <button
                      className="text-foreground/40 hover:text-foreground/70"
                      onClick={() => { navigator.clipboard.writeText(k.key_id); toast.success('已复制 key_id') }}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                  <div className="mt-1.5 text-[10px] text-foreground/45 flex flex-wrap gap-x-3 gap-y-0.5">
                    {k.scopes && k.scopes.length > 0 && <span>scopes: {k.scopes.join(', ')}</span>}
                    {k.rate_limit && (
                      <span>
                        限流: {k.rate_limit.per_minute ?? '∞'}/min · {k.rate_limit.per_day ?? '∞'}/day
                      </span>
                    )}
                    {k.allowed_origins && k.allowed_origins.length > 0 && (
                      <span>origins: {k.allowed_origins.join(', ')}</span>
                    )}
                    {k.last_used_at && (
                      <span>最近使用: {new Date(k.last_used_at).toLocaleString('zh-CN')}</span>
                    )}
                    <span className="text-foreground/35">创建: {new Date(k.created_at).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost" size="sm" className="h-7 w-7 p-0"
                    title="查看此 Key 的调用日志"
                    onClick={() => setNavRequest({ tab: 'history', filterKeyId: k.key_id })}
                  >
                    <History size={12} />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="h-7 w-7 p-0"
                    title="轮换 secret"
                    onClick={() => {
                      if (confirm(`轮换「${k.name}」的 secret？旧 secret 将立即失效。`)) {
                        rotate.mutate(k.id)
                      }
                    }}
                  >
                    <RotateCw size={12} />
                  </Button>
                  {k.is_active && (
                    <Button
                      variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive"
                      title="停用"
                      onClick={() => {
                        if (confirm(`停用「${k.name}」？该 Key 立即不可用。`)) {
                          deactivate.mutate(k.id)
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </Button>
                  )}
                </div>
              </div>
              <KeyUsageStrip keyPk={k.id} />
            </div>
          ))}
        </div>
      )}

      <CreateKeyDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(k) => {
          setShowCreate(false)
          setCreatedKey(k)
          queryClient.invalidateQueries({ queryKey: ['api-keys'] })
        }}
      />

      <RevealSecretDialog
        keyData={createdKey}
        onClose={() => setCreatedKey(null)}
      />
    </div>
  )
}

interface UsageData {
  series: { date: string; count: number; error_count: number }[]
  total: number
  total_errors: number
  today: { date: string; count: number; quota: number; remaining: number | null; pct: number | null }
}

function KeyUsageStrip({ keyPk }: { keyPk: string }) {
  const { data } = useQuery<UsageData>({
    queryKey: ['api-key-usage', keyPk],
    queryFn: () => fetch(`${KEYS_API}/${keyPk}/usage?days=7`).then((r) => r.json()),
    refetchInterval: 30_000,
  })

  if (!data) return null

  const { today, series, total, total_errors } = data
  const peak = series.reduce((m, d) => Math.max(m, d.count), 1)
  const pct = today.pct != null ? Math.round(today.pct * 100) : null

  // Quota status color: green < 60%, warning < 90%, destructive ≥ 90%
  const quotaTone =
    pct == null   ? 'text-foreground/45'
    : pct >= 90   ? 'text-destructive'
    : pct >= 60   ? 'text-warning'
    :               'text-success'

  return (
    <div className="mt-3 pt-3 border-t border-foreground/5 flex items-center gap-4 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="text-foreground/45">今日</span>
        <span className={cn('font-medium tabular-nums', quotaTone)}>
          {today.count.toLocaleString()}
        </span>
        {today.quota > 0 ? (
          <>
            <span className="text-foreground/30">/</span>
            <span className="text-foreground/55 tabular-nums">{today.quota.toLocaleString()}</span>
            <span className={cn('text-[10px] ml-0.5', quotaTone)}>({pct}%)</span>
          </>
        ) : (
          <span className="text-foreground/35 text-[10px]">· 无每日上限</span>
        )}
      </div>

      {today.quota > 0 && (
        <div className="flex-1 max-w-[180px] h-1 rounded-full bg-foreground/[0.06] overflow-hidden">
          <div
            className={cn(
              'h-full transition-all',
              pct! >= 90 ? 'bg-destructive/70'
              : pct! >= 60 ? 'bg-warning/70'
              : 'bg-success/70',
            )}
            style={{ width: `${Math.min(100, pct!)}%` }}
          />
        </div>
      )}

      <div className="ml-auto flex items-end gap-0.5 h-5" title="近 7 天调用量">
        {series.map((d) => {
          const h = Math.max(2, Math.round((d.count / peak) * 18))
          return (
            <div
              key={d.date}
              className={cn(
                'w-1 rounded-sm transition-colors',
                d.error_count > 0 ? 'bg-destructive/50' : 'bg-foreground/25',
              )}
              style={{ height: `${h}px` }}
              title={`${d.date.slice(5)}: ${d.count} 次${d.error_count ? ` (${d.error_count} 错误)` : ''}`}
            />
          )
        })}
      </div>

      <span className="text-foreground/45 tabular-nums">
        近 7 天 {total.toLocaleString()}
        {total_errors > 0 && <span className="text-destructive ml-1">({total_errors} 错误)</span>}
      </span>
    </div>
  )
}


function CreateKeyDialog({ open, onClose, onCreated }: {
  open: boolean
  onClose: () => void
  onCreated: (k: CreatedKey) => void
}) {
  const [name, setName] = useState('')
  const [clientType, setClientType] = useState('server')
  const [origins, setOrigins] = useState('')
  const [scopes, setScopes] = useState('images:read,tags:read')
  const [perMin, setPerMin] = useState('60')
  const [perDay, setPerDay] = useState('10000')

  const create = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        client_type: clientType,
        allowed_origins: origins.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) || null,
        scopes: scopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        rate_limit: {
          per_minute: perMin ? Number(perMin) : null,
          per_day: perDay ? Number(perDay) : null,
        },
      }
      const res = await fetch(KEYS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<CreatedKey>
    },
    onSuccess: (k) => {
      setName(''); setOrigins('')
      onCreated(k)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[15px]">新建 API Key</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="例如：Sandu H5 生产" className="h-8 text-[13px]" />
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">客户端类型</label>
            <select
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
              className="w-full h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
            >
              <option value="server">server (服务端调用)</option>
              <option value="h5">h5 (浏览器/H5)</option>
              <option value="app">app (移动端)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">权限范围 (scopes，逗号分隔)</label>
            <Input value={scopes} onChange={(e) => setScopes(e.target.value)}
              placeholder="images:read,tags:read" className="h-8 text-[13px] font-mono" />
            <p className="text-[10px] text-foreground/35">
              常用：images:read · tags:read · matrix:read · batches:read · generate:write
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">允许来源 origins (CORS，可选，逗号分隔)</label>
            <Input value={origins} onChange={(e) => setOrigins(e.target.value)}
              placeholder="https://h5.example.com" className="h-8 text-[13px] font-mono" />
            <p className="text-[10px] text-foreground/35">支持通配前缀 *.example.com；留空表示不限制</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">每分钟限</label>
              <Input value={perMin} onChange={(e) => setPerMin(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="60" className="h-8 text-[13px]" />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">每日限</label>
              <Input value={perDay} onChange={(e) => setPerDay(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="10000" className="h-8 text-[13px]" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!name || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RevealSecretDialog({ keyData, onClose }: { keyData: CreatedKey | null; onClose: () => void }) {
  if (!keyData) return null
  const bearer = `${keyData.key_id}.${keyData.secret}`
  return (
    <Dialog open={!!keyData} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px] flex items-center gap-2">
            <Key size={14} />
            保存 secret（仅显示一次）
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-[12px] text-warning">
            ⚠️ 这是「{keyData.name}」的 plain-text secret。<strong>关闭此对话框后将无法再查看</strong>。
            请立即复制并保存到密钥管理工具中。
          </div>
          <div>
            <div className="text-[11px] text-foreground/50 mb-1">key_id</div>
            <div className="flex gap-1">
              <code className="flex-1 px-2 py-2 rounded bg-foreground/[0.04] text-[12px] font-mono break-all">
                {keyData.key_id}
              </code>
              <Button variant="outline" size="sm" className="h-auto" onClick={() => {
                navigator.clipboard.writeText(keyData.key_id); toast.success('已复制 key_id')
              }}>
                <Copy size={12} />
              </Button>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-foreground/50 mb-1">secret (明文，仅本次显示)</div>
            <div className="flex gap-1">
              <code className="flex-1 px-2 py-2 rounded bg-foreground/[0.04] text-[12px] font-mono break-all">
                {keyData.secret}
              </code>
              <Button variant="outline" size="sm" className="h-auto" onClick={() => {
                navigator.clipboard.writeText(keyData.secret); toast.success('已复制 secret')
              }}>
                <Copy size={12} />
              </Button>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-foreground/50 mb-1">Bearer Token (key_id.secret)</div>
            <div className="flex gap-1">
              <code className="flex-1 px-2 py-2 rounded bg-foreground/[0.04] text-[12px] font-mono break-all">
                {bearer}
              </code>
              <Button variant="outline" size="sm" className="h-auto" onClick={() => {
                navigator.clipboard.writeText(bearer); toast.success('已复制 Bearer token')
              }}>
                <Copy size={12} />
              </Button>
            </div>
            <p className="text-[10px] text-foreground/35 mt-1">
              使用方式：<code className="px-1 bg-foreground/[0.04] rounded">Authorization: Bearer {bearer.slice(0, 20)}…</code>
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
