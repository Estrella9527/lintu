import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api , apiFetchRaw } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'
import { AlertCircle, CheckCircle2, ChevronDown, Cloud, Clock, Eye, EyeOff, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

const API_BASE = 'http://127.0.0.1:7879'

interface OssStatus {
  configured: boolean
  provider: string
  bucket: string
  cdn_base: string
  queue: { pending: number; running: number; done: number; failed: number; skipped: number }
  throughput: { jobs_per_min: number; eta_sec: number | null }
  coverage: {
    total_images: number
    /** OSS bucket 上 unique image 数(后端 cache 上次探测值;手动刷新更新) */
    remote_synced_images: number | null
    /** OSS 对象总数(图 + 缩略) */
    remote_objects: number | null
    /** 上次探测时间(ISO);null = 从未探测过 */
    remote_probed_at: string | null
    /** 这次响应是否真跑了新探测(只在用户点刷新后这一次响应是 true) */
    remote_probe_just_ran: boolean
    /** 探测失败原因(null = 没探测过 或 探测成功) */
    remote_probe_error: string | null
    /** 历史:数据库 cdn_path 字段标记为同步过的图数(可能跟实际不一致) */
    db_recorded: number
    /** 旧字段兼容,等同 db_recorded */
    synced_images: number
    pending_images: number
    pct: number
    /** db_recorded === remote_synced_images?null = 没探测过 */
    is_consistent: boolean | null
  }
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
    // 自动 poll 不带 probe,只查 db(快)+ 拿后端 cache 里的上次探测值。
    // 用户主动点"刷新(含实时探测)"才触发新一次 OSS list(写 cache)。
    queryFn: () => apiFetchRaw('/oss/status').then(r => r.json()),
    refetchInterval: 5_000,
  })

  const { data: recentData } = useQuery<{ items: RecentJob[] }>({
    queryKey: ['oss-recent-jobs'],
    queryFn: () => apiFetchRaw(`/oss/recent-jobs?limit=15`).then((r) => r.json()),
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
  const [probing, setProbing] = useState(false)

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
      const res = await apiFetchRaw(`/oss/test`, { method: 'POST' })
      return res.json()
    },
    onSuccess: (r: any) => setTestResult(r),
    onError: (e: Error) => setTestResult({ ok: false, error: e.message }),
  })

  const backfill = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw(`/oss/backfill`, {
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
      const res = await apiFetchRaw(`/oss/retry-failed`, { method: 'POST' })
      return res.json()
    },
    onSuccess: (r: any) => {
      if (r.reset > 0) toast.success(`已重置 ${r.reset} 个失败任务`)
      else toast.message('没有失败任务')
      refetchStatus()
    },
  })

  // 清空 / 重置 — 两档模式:软重置(只动本地)/ 全清(也删 OSS 上 i/ 前缀对象)
  // 后端要求 confirm = "RESET-YYYY-MM-DD",前端自动拼当天 UTC 日期。
  const _todayConfirm = () => {
    const d = new Date()
    const utc = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
    return `RESET-${utc}`
  }
  const resetLocal = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw(`/oss/reset-local`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: _todayConfirm() }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (r: any) => {
      toast.success(`已重置 ${r.images_reset} 张图片 + 删 ${r.jobs_deleted} 个任务(OSS 对象保留)`)
      refetchStatus()
    },
    onError: (e: Error) => toast.error(`重置失败:${e.message}`),
  })
  const reconcile = useMutation({
    mutationFn: async ({ force_push_all = false }: { force_push_all?: boolean }) => {
      const qs = force_push_all ? '?force_push_all=true' : ''
      const res = await apiFetchRaw(`/oss/reconcile${qs}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (r: any) => {
      const pushed = r.cloud_sync_enqueued ?? 0
      if (r.ghost_cleared === 0 && pushed === 0) {
        toast.success(`已一致 · OSS ${r.on_oss} 张 = 库 ${r.db_with_cdn ?? r.db_with_cdn_after} 张(云端未推送)`)
      } else if (r.ghost_cleared > 0) {
        toast.success(
          `对账完成:清 ${r.ghost_cleared} 张幽灵 + 推 ${pushed} 张到云端`,
          { description: `OSS 实际 ${r.on_oss} · cloud sync 60s 内推完,UGC 立刻对齐` }
        )
      } else {
        toast.success(
          `强制重推 ${pushed} 张图到云端`,
          { description: `60s 内 cloud sync 推完,云端数据库对齐` }
        )
      }
      refetchStatus()
    },
    onError: (e: Error) => toast.error(`对账失败:${e.message}`),
  })

  const clearRemote = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw(`/oss/clear-remote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: _todayConfirm() }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (r: any) => {
      toast.success(`已删 OSS ${r.oss_objects_deleted}/${r.oss_objects_listed} 对象 + 重置 ${r.images_reset} 张本地`)
      refetchStatus()
    },
    onError: (e: Error) => toast.error(`清空失败:${e.message}`),
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
            disabled={probing}
            onClick={async () => {
              // 实时探测:绕过 react-query cache 直接调一次带 probe_remote=true。
              // 后端会 list 整个 i/ 前缀,bucket 大时可能要好几秒 — 全程禁用按钮
              // + 图标 spinner 让用户知道在跑,失败时弹 toast 而不是吞掉错误。
              setProbing(true)
              try {
                const res = await apiFetchRaw(`/oss/status?probe_remote=true`)
                if (!res.ok) {
                  const body = await res.text().catch(() => '')
                  toast.error(`OSS 刷新失败 · HTTP ${res.status}`, { description: body.slice(0, 200) })
                  return
                }
                const r = await res.json()
                queryClient.setQueryData(['oss-status'], r)
                if (r.coverage?.remote_probe_error) {
                  toast.error(`OSS 实时探测失败:${r.coverage.remote_probe_error}`)
                } else if (r.coverage?.is_consistent === false) {
                  toast.message(
                    `库记录 ${r.coverage.db_recorded} 张 ≠ OSS 实际 ${r.coverage.remote_synced_images} 张`,
                    { description: '可能 OSS 被外部清空过。建议:软重置 → 一键回填' }
                  )
                } else if (r.coverage?.is_consistent === true) {
                  toast.success(`一致 · OSS 实际 ${r.coverage.remote_synced_images} 张(数字已锁定显示,下次刷新前不变)`)
                } else if (r.coverage?.remote_synced_images != null) {
                  toast.success(`OSS 实际 ${r.coverage.remote_synced_images} 张(已锁定显示)`)
                }
              } catch (e: any) {
                toast.error(`OSS 刷新失败:${e?.message ?? String(e)}`)
              } finally {
                setProbing(false)
              }
            }}
            title="去 OSS 实时 list 一次,结果会持久化显示,直到你再点一次刷新"
          >
            {probing
              ? <Loader2 size={11} className="mr-1 animate-spin" />
              : <RefreshCw size={11} className="mr-1" />}
            {probing ? '探测中…' : '刷新(含实时探测)'}
          </Button>
        </div>

        {/* 主指标:实时在云的状态(每 30s 自动 probe,介于两次 probe 之间显示上次数值不闪烁) */}
        <div className="grid grid-cols-4 gap-3 text-[12px] mb-3">
          <Stat
            label="OSS 实际"
            value={
              status?.coverage.remote_synced_images != null
                ? status.coverage.remote_synced_images.toLocaleString()
                : '—'
            }
            sub={
              status?.coverage.remote_synced_images != null
                ? `/${status.coverage.total_images}`
                : '未探测'
            }
            sub2={
              status?.coverage.remote_synced_images != null
                ? `探测 ${formatRelative(status.coverage.remote_probed_at)}`
                : '点右上刷新'
            }
            tone={
              status?.coverage.remote_synced_images === 0 ? 'destructive'
              : (status?.coverage.is_consistent === false ? 'pending' : 'success')
            }
          />
          <Stat label="待上传" value={String(status?.queue.pending ?? 0)} tone={status && status.queue.pending > 0 ? 'pending' : 'muted'} />
          <Stat label="正在上传" value={String(status?.queue.running ?? 0)} tone="muted" />
          <Stat label="失败" value={String(status?.queue.failed ?? 0)} tone={status && status.queue.failed > 0 ? 'destructive' : 'muted'} />
        </div>

        {/* 库记录(历史)+ 一致性提示 */}
        <div className="flex items-center gap-3 text-[10.5px] text-foreground/45 mb-2 flex-wrap">
          <span>
            历史登记 <span className="text-foreground/70 tabular-nums">{(status?.coverage.db_recorded ?? 0).toLocaleString()}</span>
            <span className="text-foreground/30 ml-0.5"> / {status?.coverage.total_images ?? 0}</span>
          </span>
          {status?.coverage.is_consistent === false && status?.coverage.remote_synced_images != null && (
            <span className="text-warning inline-flex items-center gap-1">
              <AlertCircle size={10} />
              库记录与 OSS 不一致(差 {Math.abs((status.coverage.db_recorded || 0) - (status.coverage.remote_synced_images || 0))} 张)— 建议软重置后回填
            </span>
          )}
          {status?.coverage.is_consistent === true && (
            <span className="text-success inline-flex items-center gap-1">
              <CheckCircle2 size={10} /> 库与 OSS 一致
            </span>
          )}
          {status?.coverage.remote_probe_error && (
            <span className="text-destructive truncate" title={status.coverage.remote_probe_error}>
              探测失败:{status.coverage.remote_probe_error.slice(0, 60)}
            </span>
          )}
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

        {/* 主操作行 — 日常 3 个按钮 */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <Button
            size="sm" className="h-8 text-[12px]"
            disabled={!status?.configured || backfill.isPending}
            onClick={() => {
              if (confirm(`将所有未上传的图片入队上传到 OSS?当前未同步:${status?.coverage.pending_images.toLocaleString()} 张。`)) {
                backfill.mutate()
              }
            }}
            title="把库里 cdn_path=NULL 的图全部入 OSS 上传队列"
          >
            {backfill.isPending && <Loader2 size={12} className="mr-1 animate-spin" />}
            <Upload size={12} className="mr-1" /> 一键回填全库
          </Button>
          <Button
            variant="outline" size="sm" className="h-8 text-[12px]"
            onClick={() => reconcile.mutate({ force_push_all: false })}
            disabled={!status?.configured || reconcile.isPending}
            title="对账:实时 list OSS,清「幽灵图」(库标记同步但 OSS 没的)+ 推到云端 sidecar"
          >
            {reconcile.isPending && <Loader2 size={12} className="mr-1 animate-spin" />}
            <CheckCircle2 size={12} className="mr-1" /> 对账库 vs OSS
          </Button>
          {status && status.queue.failed > 0 && (
            <Button
              variant="outline" size="sm" className="h-8 text-[12px]"
              onClick={() => retryFailed.mutate()}
              disabled={retryFailed.isPending}
              title="把队列里 failed 的 job 重置为 pending,让 worker 重试"
            >
              <RefreshCw size={12} className="mr-1" /> 重试 {status.queue.failed} 个失败
            </Button>
          )}

          {/* 高级操作 dropdown — 放右侧,折叠减少视觉噪音 */}
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost" size="sm" className="h-8 text-[12px] text-foreground/60"
                  disabled={!status?.configured}
                >
                  高级
                  <ChevronDown size={12} className="ml-1 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="text-[10.5px] text-foreground/40">
                  云端同步
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => {
                    const total = status?.coverage.total_images ?? 0
                    if (confirm(`重推所有 ${total} 张图到云端 sidecar?\n\n用于「本地已对齐但云端没收到」的修复(比如 cloud sync 之前断过)。\n\nworker 在 30-120 秒内推完,不影响 UGC 使用。`)) {
                      reconcile.mutate({ force_push_all: true })
                    }
                  }}
                  disabled={reconcile.isPending}
                  className="text-[12.5px] gap-2"
                >
                  <Upload size={13} className="text-foreground/55" />
                  <div className="flex-1">
                    <div>强制重推全量到云端</div>
                    <div className="text-[10px] text-foreground/40">把所有 image 入 cloud sync 队列</div>
                  </div>
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10.5px] text-foreground/40">
                  危险操作
                </DropdownMenuLabel>

                <DropdownMenuItem
                  onClick={() => {
                    const synced = status?.coverage.synced_images ?? 0
                    if (confirm(`软重置:把 ${synced} 张已同步图片的 cdn_path 清空 + 删光同步任务队列。\n\n⚠️ OSS 上的对象保留,后续重传同 key 自动覆盖。`)) {
                      resetLocal.mutate()
                    }
                  }}
                  disabled={resetLocal.isPending}
                  className="text-[12.5px] gap-2"
                >
                  <RefreshCw size={13} className="text-warning" />
                  <div className="flex-1">
                    <div className="text-warning">软重置(只动本地)</div>
                    <div className="text-[10px] text-foreground/40">清 cdn_path,不动 OSS 对象</div>
                  </div>
                </DropdownMenuItem>

                <DropdownMenuItem
                  onClick={() => {
                    if (!confirm(`【危险】清空 OSS 上 lintu 同步的对象(i/ 前缀)+ 重置本地。\n\n客户当前能访问的 CDN URL 会全部失效,直到你重新上传。`)) return
                    if (!confirm(`再次确认:删除 OSS bucket 上 i/ 前缀全部对象,不可恢复。`)) return
                    clearRemote.mutate()
                  }}
                  disabled={clearRemote.isPending}
                  className="text-[12.5px] gap-2"
                >
                  <Trash2 size={13} className="text-destructive" />
                  <div className="flex-1">
                    <div className="text-destructive">全清(删 OSS 对象)</div>
                    <div className="text-[10px] text-foreground/40">真删 OSS 上 i/ 对象,需双重确认</div>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
        <div className="flex items-center gap-1.5">
          <h2 className="text-[13px] font-semibold text-foreground/80">阿里云 OSS 配置</h2>
          <InfoHint text={
            '配置后，新增 / 生成的图片会异步推送到 OSS；Open API 返回的 URL 优先指向 CDN。\n' +
            '密钥保存后服务端只显示掩码，留空不修改。'
          } />
        </div>

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

function Stat({ label, value, sub, sub2, tone }: { label: string; value: string; sub?: string; sub2?: string; tone: 'success' | 'pending' | 'destructive' | 'muted' }) {
  const color =
    tone === 'success' ? 'text-success'
    : tone === 'pending' ? 'text-warning'
    : tone === 'destructive' ? 'text-destructive'
    : 'text-foreground/85'
  return (
    <div className="rounded-md bg-foreground/[0.025] px-3 py-2">
      <div className="text-[10.5px] text-foreground/50">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1 whitespace-nowrap">
        <span className={cn('text-[15px] font-semibold tabular-nums', color)}>{value}</span>
        {sub && <span className="text-[10px] text-foreground/40 tabular-nums">{sub}</span>}
      </div>
      {sub2 && <div className="text-[10px] text-foreground/35 tabular-nums truncate mt-0.5">{sub2}</div>}
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
