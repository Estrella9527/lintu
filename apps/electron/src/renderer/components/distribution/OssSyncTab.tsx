import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { AlertCircle, CheckCircle2, Cloud, Clock, Eye, EyeOff, Loader2, RefreshCw, Upload } from 'lucide-react'

const API_BASE = 'http://localhost:7879'

interface OssStatus {
  configured: boolean
  provider: string
  bucket: string
  cdn_base: string
  queue: { pending: number; running: number; done: number; failed: number; skipped: number }
  throughput: { jobs_per_min: number; eta_sec: number | null }
  coverage: { total_images: number; synced_images: number; pending_images: number; pct: number }
}

interface RecentJob {
  id: number
  image_id: string
  asset_kind: string
  object_key: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string | null
  completed_at: string | null
  file_name: string | null
}

function formatEta(sec: number | null): string {
  if (sec == null || sec <= 0) return ''
  if (sec < 60) return `约 ${sec} 秒`
  if (sec < 3600) return `约 ${Math.round(sec / 60)} 分钟`
  return `约 ${(sec / 3600).toFixed(1)} 小时`
}

function formatRelative(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diff = Math.round((Date.now() - t) / 1000)
  if (diff < 5) return '刚刚'
  if (diff < 60) return `${diff}秒前`
  if (diff < 3600) return `${Math.round(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.round(diff / 3600)}小时前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

const KIND_LABEL: Record<string, string> = {
  original: '原图',
  thumb_300: '缩略 300',
  thumb_800: '缩略 800',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'text-foreground/45',
  running: 'text-info',
  done: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-foreground/35',
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '上传中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
}

export function OssSyncTab() {
  const queryClient = useQueryClient()
  const { data: config } = useQuery<Record<string, any>>({
    queryKey: ['config'],
    queryFn: () => api.config.get() as any,
  })

  const { data: status, refetch: refetchStatus } = useQuery<OssStatus>({
    queryKey: ['oss-status'],
    queryFn: () => fetch(`${API_BASE}/api/oss/status`).then((r) => r.json()),
    refetchInterval: 3_000,
  })

  const { data: recentData } = useQuery<{ items: RecentJob[] }>({
    queryKey: ['oss-recent-jobs'],
    queryFn: () => fetch(`${API_BASE}/api/oss/recent-jobs?limit=15`).then((r) => r.json()),
    refetchInterval: 3_000,
    enabled: !!status?.configured,
  })

  // ── Form state (controlled inputs) ────────────────────────────────────────
  const [provider, setProvider] = useState<'' | 'aliyun'>('aliyun')
  const [endpoint, setEndpoint] = useState('')
  const [bucket, setBucket] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [accessSecret, setAccessSecret] = useState('')
  const [cdnBase, setCdnBase] = useState('')
  const [signedTtl, setSignedTtl] = useState('0')
  const [showSecret, setShowSecret] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)

  useEffect(() => {
    if (!config) return
    setProvider((config.oss_provider as any) || 'aliyun')
    setEndpoint(config.oss_endpoint || '')
    setBucket(config.oss_bucket || '')
    setAccessKey(config.oss_access_key || '')
    setAccessSecret(config.oss_access_secret || '')
    setCdnBase(config.oss_cdn_base || '')
    setSignedTtl(String(config.oss_signed_url_ttl_sec || 0))
  }, [config])

  const save = useMutation({
    mutationFn: () => api.config.update({
      oss_provider: provider,
      oss_endpoint: endpoint.trim(),
      oss_bucket: bucket.trim(),
      oss_access_key: accessKey,
      oss_access_secret: accessSecret,
      oss_cdn_base: cdnBase.trim().replace(/\/+$/, ''),
      oss_signed_url_ttl_sec: Number(signedTtl) || 0,
    } as any),
    onSuccess: () => {
      toast.success('OSS 配置已保存')
      queryClient.invalidateQueries({ queryKey: ['config'] })
      queryClient.invalidateQueries({ queryKey: ['oss-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const test = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/oss/test`, { method: 'POST' })
      return res.json()
    },
    onSuccess: (r: any) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, error: e.message }),
  })

  const backfill = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/oss/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (r: any) => {
      toast.success(`已入队 ${r.images} 张图片（共 ${r.jobs_added} 个上传任务）`)
      refetchStatus()
    },
    onError: (e: Error) => toast.error(`回填失败：${e.message}`),
  })

  const retryFailed = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/oss/retry-failed`, { method: 'POST' })
      return res.json()
    },
    onSuccess: (r: any) => {
      if (r.reset > 0) toast.success(`已重置 ${r.reset} 个失败任务`)
      else toast.message('没有失败任务')
      refetchStatus()
    },
  })

  const looksMasked = (v: string) => v.includes('****')
  const dirty = !!config && (
    provider !== (config.oss_provider || '')
    || endpoint !== (config.oss_endpoint || '')
    || bucket !== (config.oss_bucket || '')
    || accessKey !== (config.oss_access_key || '')
    || accessSecret !== (config.oss_access_secret || '')
    || cdnBase !== (config.oss_cdn_base || '')
    || Number(signedTtl) !== (config.oss_signed_url_ttl_sec || 0)
  )

  const coveragePct = Math.round((status?.coverage.pct || 0) * 100)

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Status card */}
      <section className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-4">
        <div className="flex items-center gap-2 mb-3">
          <Cloud size={14} className="text-foreground/55" />
          <h2 className="text-[13px] font-semibold text-foreground/80">同步状态</h2>
          {status?.configured ? (
            <span className="text-[10px] text-success inline-flex items-center gap-1">
              <CheckCircle2 size={11} /> 已配置
            </span>
          ) : (
            <span className="text-[10px] text-foreground/45">未配置</span>
          )}
          <Button
            variant="ghost" size="sm"
            className="ml-auto h-7 text-[11px]"
            onClick={() => refetchStatus()}
            title="刷新"
          >
            <RefreshCw size={11} className="mr-1" /> 刷新
          </Button>
        </div>

        <div className="grid grid-cols-4 gap-3 text-[12px] mb-3">
          <Stat label="已同步" value={`${(status?.coverage.synced_images ?? 0).toLocaleString()}`} sub={`/${status?.coverage.total_images ?? 0}`} tone="success" />
          <Stat label="待上传" value={String(status?.queue.pending ?? 0)} tone={status && status.queue.pending > 0 ? 'pending' : 'muted'} />
          <Stat label="正在上传" value={String(status?.queue.running ?? 0)} tone="muted" />
          <Stat label="失败" value={String(status?.queue.failed ?? 0)} tone={status && status.queue.failed > 0 ? 'destructive' : 'muted'} />
        </div>

        {status && status.coverage.total_images > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10.5px] text-foreground/45">
              <span>同步覆盖率</span>
              <div className="flex items-center gap-3 tabular-nums">
                {status.throughput.jobs_per_min > 0 && (
                  <span className="text-info">
                    速度 {status.throughput.jobs_per_min}/分钟
                  </span>
                )}
                {status.throughput.eta_sec != null && (
                  <span className="inline-flex items-center gap-0.5 text-warning">
                    <Clock size={10} /> 剩余 {formatEta(status.throughput.eta_sec)}
                  </span>
                )}
                <span>{coveragePct}%</span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-foreground/[0.06] overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all',
                  coveragePct >= 95 ? 'bg-success/70'
                  : coveragePct >= 60 ? 'bg-warning/70'
                  : 'bg-foreground/30',
                )}
                style={{ width: `${coveragePct}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-3">
          <Button
            size="sm" className="h-8 text-[12px]"
            disabled={!status?.configured || backfill.isPending}
            onClick={() => {
              if (confirm(`将所有未上传的图片入队上传到 OSS？当前未同步：${status?.coverage.pending_images.toLocaleString()} 张。`)) {
                backfill.mutate()
              }
            }}
          >
            {backfill.isPending && <Loader2 size={12} className="mr-1 animate-spin" />}
            <Upload size={12} className="mr-1" /> 一键回填全库
          </Button>
          {status && status.queue.failed > 0 && (
            <Button
              variant="outline" size="sm" className="h-8 text-[12px]"
              onClick={() => retryFailed.mutate()}
              disabled={retryFailed.isPending}
            >
              <RefreshCw size={12} className="mr-1" /> 重试 {status.queue.failed} 个失败
            </Button>
          )}
        </div>
      </section>

      {/* Real-time activity feed */}
      {status?.configured && recentData?.items && recentData.items.length > 0 && (
        <section className="rounded-lg border border-foreground/8 p-4">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-[13px] font-semibold text-foreground/80">最近活动</h2>
            <span className="text-[10.5px] text-foreground/40">最新 {recentData.items.length} 条 · 自动刷新</span>
          </div>
          <div className="rounded-md border border-foreground/5 max-h-[260px] overflow-y-auto divide-y divide-foreground/5 text-[11.5px]">
            {recentData.items.map((j) => (
              <div key={j.id} className="px-3 py-1.5 flex items-center gap-2">
                <span className={cn('w-12 shrink-0 font-medium', STATUS_TONE[j.status] || 'text-foreground/55')}>
                  {STATUS_LABEL[j.status] || j.status}
                </span>
                <span className="text-foreground/40 text-[10px] w-14 shrink-0">
                  {KIND_LABEL[j.asset_kind] || j.asset_kind}
                </span>
                <span className="flex-1 truncate text-foreground/75" title={j.file_name || j.image_id}>
                  {j.file_name || j.image_id.slice(0, 12)}
                </span>
                {j.attempts > 1 && (
                  <span className="text-warning text-[10px]" title={`重试 ${j.attempts} 次`}>
                    ↻ {j.attempts}
                  </span>
                )}
                {j.last_error && (
                  <span className="text-destructive text-[10px] truncate max-w-[180px]" title={j.last_error}>
                    <AlertCircle size={9} className="inline mr-0.5" />
                    {j.last_error.slice(0, 30)}
                  </span>
                )}
                <span className="text-foreground/35 text-[10px] tabular-nums shrink-0">
                  {formatRelative(j.completed_at || j.created_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Config card */}
      <section className="rounded-lg border border-foreground/8 p-4 space-y-3">
        <h2 className="text-[13px] font-semibold text-foreground/80">阿里云 OSS 配置</h2>
        <p className="text-[11px] text-foreground/45">
          配置后，新增 / 生成的图片会异步推送到 OSS；Open API 返回的 URL 优先指向 CDN。
          密钥保存后服务端只显示掩码，留空不修改。
        </p>

        <FormRow label="服务商">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as any)}
            className="w-48 h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
          >
            <option value="">禁用（不推送）</option>
            <option value="aliyun">阿里云 OSS</option>
          </select>
        </FormRow>

        <FormRow label="Endpoint">
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="oss-cn-hangzhou.aliyuncs.com"
            className="h-8 text-[13px] font-mono"
          />
        </FormRow>

        <FormRow label="Bucket">
          <Input
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            placeholder="lintu-prod"
            className="h-8 text-[13px] font-mono"
          />
        </FormRow>

        <FormRow label="Access Key ID">
          <Input
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            placeholder="LTAI..."
            className="h-8 text-[13px] font-mono"
          />
        </FormRow>

        <FormRow label="Access Secret">
          <div className="relative flex-1">
            <Input
              type={showSecret ? 'text' : 'password'}
              value={accessSecret}
              onChange={(e) => setAccessSecret(e.target.value)}
              placeholder={looksMasked(accessSecret) ? '已配置（留空不修改）' : ''}
              className="h-8 text-[13px] pr-8 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/30 hover:text-foreground/60"
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </FormRow>

        <FormRow label="CDN 域名">
          <Input
            value={cdnBase}
            onChange={(e) => setCdnBase(e.target.value)}
            placeholder="https://cdn.lintu.com（留空回退到 OSS bucket 域名）"
            className="h-8 text-[13px] font-mono"
          />
        </FormRow>

        <FormRow label="签名 URL 有效期">
          <div className="flex items-center gap-2">
            <Input
              type="number" min={0} max={86400}
              value={signedTtl}
              onChange={(e) => setSignedTtl(e.target.value.replace(/[^0-9]/g, ''))}
              className="h-8 w-32 text-[13px]"
            />
            <span className="text-[10px] text-foreground/40">秒 · 0 = 公开访问（不签名）</span>
          </div>
        </FormRow>

        {testResult && (
          <div className={cn(
            'text-[11px] px-2 py-1.5 rounded',
            testResult.ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
          )}>
            {testResult.ok ? testResult.message : testResult.error}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <Button
            variant="outline" size="sm" className="h-8 text-[12px]"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending && <Loader2 size={12} className="mr-1 animate-spin" />}
            测试连接
          </Button>
          <Button
            size="sm" className="h-8 text-[12px]"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? '保存中…' : '保存配置'}
          </Button>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'success' | 'pending' | 'destructive' | 'muted' }) {
  const color =
    tone === 'success' ? 'text-success'
    : tone === 'pending' ? 'text-warning'
    : tone === 'destructive' ? 'text-destructive'
    : 'text-foreground/85'
  return (
    <div className="rounded-md bg-foreground/[0.025] px-3 py-2">
      <div className="text-[10.5px] text-foreground/50">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={cn('text-[15px] font-semibold tabular-nums', color)}>{value}</span>
        {sub && <span className="text-[10px] text-foreground/40 tabular-nums">{sub}</span>}
      </div>
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-center">
      <label className="text-[12px] text-foreground/55 w-28 shrink-0">{label}</label>
      <div className="flex-1 flex">{children}</div>
    </div>
  )
}
