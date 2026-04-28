import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { DetailDrawer } from '@/components/shared/DetailDrawer'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle, Copy, Download, ExternalLink, Image as ImageIcon, RotateCcw, X } from 'lucide-react'

import { activeModuleAtom, assetLibraryNavRequestAtom, settingsTabAtom } from '@/atoms/navigation'
import { api, type BatchPromptGroup, type BatchRunRecord, type BatchSubtaskRecord, type PromptRecord } from '@/lib/api'

interface Props {
  batch: BatchRunRecord | null
  onClose: () => void
}

export function BatchDetailDrawer({ batch, onClose }: Props) {
  const open = !!batch
  const batchId = batch?.id
  const queryClient = useQueryClient()
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const setAssetNav = useSetAtom(assetLibraryNavRequestAtom)
  const [retried, setRetried] = useState<number | null>(null)

  const retryMutation = useMutation({
    mutationFn: () => api.batches.retryFailed(batchId!),
    onSuccess: (res: any) => {
      const n = Number(res?.retried ?? 0)
      setRetried(n)
      if (n > 0) {
        toast.success(`已重置 ${n} 条失败任务，继续执行中`)
      } else {
        toast.message('当前没有可重试的失败任务')
      }
      queryClient.invalidateQueries({ queryKey: ['batch-subtasks', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch-groups', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      window.setTimeout(() => setRetried(null), 3000)
    },
    onError: (e: any) => toast.error(`重试失败：${e?.message || e}`),
  })

  const openProviderSettings = () => {
    setSettingsTab('ai-provider')
    setActiveModule('settings')
  }

  const { data: subtasks } = useQuery<BatchSubtaskRecord[]>({
    queryKey: ['batch-subtasks', batchId],
    queryFn: () => api.batches.listSubtasks(batchId!, { limit: 2000 }),
    refetchInterval: 5000,
    enabled: open && !!batchId,
  })

  const { data: groups } = useQuery<BatchPromptGroup[]>({
    queryKey: ['batch-groups', batchId],
    queryFn: () => api.batches.groupByPrompt(batchId!),
    refetchInterval: 5000,
    enabled: open && !!batchId,
  })

  const { data: prompts } = useQuery<PromptRecord[]>({
    queryKey: ['prompts', 'all-active'],
    queryFn: () => api.prompts.list({ is_active: true }),
    enabled: open,
  })

  const promptsById = useMemo(() => {
    const map = new Map<string, PromptRecord>()
    prompts?.forEach((p) => map.set(p.id, p))
    return map
  }, [prompts])

  const failed = useMemo(() => (subtasks ?? []).filter((s) => s.status === 'failed'), [subtasks])

  const errorBuckets = useMemo(() => bucketErrors(failed), [failed])

  const seedGroups = useMemo(() => {
    const m = new Map<string, { total: number; success: number; fail: number; pending: number }>()
    subtasks?.forEach((s) => {
      const cur = m.get(s.seed_image_id) ?? { total: 0, success: 0, fail: 0, pending: 0 }
      cur.total += 1
      if (s.status === 'success') cur.success += 1
      else if (s.status === 'failed') cur.fail += 1
      else if (s.status === 'pending' || s.status === 'running' || s.status === 'retrying') cur.pending += 1
      m.set(s.seed_image_id, cur)
    })
    return Array.from(m.entries()).map(([seed_id, v]) => ({ seed_id, ...v }))
  }, [subtasks])

  // ── Cancel mutations (per-prompt / per-seed) ────────────────────────────
  const cancelByPromptMutation = useMutation({
    mutationFn: (promptId: string) => api.batches.cancelByPrompt(batchId!, promptId),
    onSuccess: (res: any) => {
      const n = Number(res?.cancelled ?? 0)
      toast.success(n > 0 ? `已取消 ${n} 条未完成任务` : '该 Prompt 没有可取消的任务')
      queryClient.invalidateQueries({ queryKey: ['batch-subtasks', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch-groups', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e: any) => toast.error(`取消失败：${e?.message || e}`),
  })
  const cancelBySeedMutation = useMutation({
    mutationFn: (seedId: string) => api.batches.cancelBySeed(batchId!, seedId),
    onSuccess: (res: any) => {
      const n = Number(res?.cancelled ?? 0)
      toast.success(n > 0 ? `已取消 ${n} 条未完成任务` : '该种子图没有可取消的任务')
      queryClient.invalidateQueries({ queryKey: ['batch-subtasks', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch-groups', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (e: any) => toast.error(`取消失败：${e?.message || e}`),
  })

  const promptPendingCount = (g: BatchPromptGroup): number => {
    const s = g.by_status || {}
    return (s['pending'] ?? 0) + (s['running'] ?? 0) + (s['retrying'] ?? 0)
  }

  const exportFailedCsv = () => {
    if (!failed.length) return
    const header = ['subtask_id', 'seed_image_id', 'prompt_id', 'prompt_name', 'retry_count', 'error_message']
    const rows = failed.map((s) => [
      s.id,
      s.seed_image_id,
      s.prompt_id,
      promptsById.get(s.prompt_id)?.name ?? '',
      String(s.retry_count ?? 0),
      (s.error_message ?? '').replace(/[\n\r,"]/g, ' '),
    ])
    const csv = [header, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `batch-${batchId}-failures.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const goAssetLibraryByPrompt = (promptId: string, promptLabel: string) => {
    setAssetNav({
      tab: 'all',
      source: 'generated',
      promptId,
      promptLabel,
      // Filter to passed (success status) so we don't show in-progress placeholder rows
      status: 'passed',
    })
    setActiveModule('asset-library')
  }

  return (
    <DetailDrawer open={open} onClose={onClose} title={batch?.name ?? '批次详情'}>
      {batch && (
        <div className="space-y-5 text-[13px]">
          {/* Quick action: jump to asset library showing all images this batch produced */}
          {batch.completed > 0 && (
            <div className="flex items-center gap-2 -mb-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => {
                  // No promptId here — show all generated images from this batch's prompts
                  // Easiest deep-link: source=generated only, user can further filter inside.
                  setAssetNav({
                    tab: 'all',
                    source: 'generated',
                    status: 'passed',
                  })
                  setActiveModule('asset-library')
                }}
              >
                <ImageIcon size={11} className="mr-1" />
                看此批次的全部成果图
              </Button>
              <span className="text-[10.5px] text-foreground/40">
                跳到资产库 · 仅生成图（{batch.completed} 张）
              </span>
            </div>
          )}

          {/* Summary */}
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <SummaryStat label="总数" value={String(batch.total)} />
            <SummaryStat label="状态" value={batch.status} />
            <SummaryStat label="成功" value={String(batch.completed)} tone="success" />
            <SummaryStat label="失败" value={String(batch.failed)} tone={batch.failed > 0 ? 'destructive' : undefined} />
            <SummaryStat label="跳过" value={String(batch.skipped)} />
            <SummaryStat label="已用成本" value={`$${Number(batch.cost_usd ?? 0).toFixed(4)}`} />
            {batch.budget_usd != null && (
              <SummaryStat label="预算" value={`$${Number(batch.budget_usd).toFixed(2)}`} />
            )}
            <SummaryStat label="并发" value={String(batch.concurrency)} />
          </div>

          {/* Per-prompt success rate */}
          <section>
            <h3 className="text-[12px] font-medium text-foreground/70 mb-2">按 Prompt 分组</h3>
            <div className="rounded-md border border-foreground/10 max-h-[260px] overflow-y-auto divide-y divide-foreground/5">
              {(groups ?? []).map((g) => {
                const total = g.total
                const ok = g.by_status?.success ?? 0
                const rate = total > 0 ? (ok / total) : 0
                const p = promptsById.get(g.prompt_id)
                const cancellable = promptPendingCount(g)
                const isCancelling = cancelByPromptMutation.isPending && cancelByPromptMutation.variables === g.prompt_id
                return (
                  <div key={g.prompt_id} className="px-3 py-2 text-[12px] group">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground/85 truncate">{p?.name || g.prompt_id.slice(0, 8)}</span>
                      {p?.task_type && <Badge variant="outline" className="text-[9px] px-1 py-0">{p.task_type}</Badge>}
                      <span className="ml-auto text-foreground/55 tabular-nums">
                        {ok}/{total} ({Math.round(rate * 100)}%)
                      </span>
                      {ok > 0 && (
                        <button
                          type="button"
                          onClick={() => goAssetLibraryByPrompt(g.prompt_id, p?.name || g.prompt_id.slice(0, 8))}
                          title={`去资产库看用此 Prompt 生成的 ${ok} 张图`}
                          className="ml-1 h-5 w-5 rounded inline-flex items-center justify-center text-foreground/35 hover:text-accent hover:bg-accent/10 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <ImageIcon size={11} />
                        </button>
                      )}
                      {cancellable > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`取消该 Prompt 下未完成的 ${cancellable} 条任务？\n（已成功/失败的记录会保留）`)) {
                              cancelByPromptMutation.mutate(g.prompt_id)
                            }
                          }}
                          disabled={isCancelling}
                          title={`取消 ${cancellable} 条未完成任务`}
                          className="h-5 w-5 rounded inline-flex items-center justify-center text-foreground/35 hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    <div className="h-1 rounded-full bg-foreground/[0.06] overflow-hidden">
                      <div
                        className={rate >= 0.85 ? 'h-full bg-success/70' : rate >= 0.5 ? 'h-full bg-warning/70' : 'h-full bg-destructive/70'}
                        style={{ width: `${rate * 100}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[10px] text-foreground/45 flex gap-3">
                      {Object.entries(g.by_status || {}).map(([k, v]) => (
                        <span key={k}>{k}: {v}</span>
                      ))}
                      <span className="ml-auto">花费 ${(g.cost_usd ?? 0).toFixed(4)}</span>
                    </div>
                  </div>
                )
              })}
              {(!groups || groups.length === 0) && (
                <div className="text-center py-6 text-[11px] text-foreground/40">暂无 subtask</div>
              )}
            </div>
          </section>

          {/* Per-seed group */}
          <section>
            <h3 className="text-[12px] font-medium text-foreground/70 mb-2">按种子图分组</h3>
            <div className="rounded-md border border-foreground/10 max-h-[200px] overflow-y-auto divide-y divide-foreground/5 text-[12px]">
              {seedGroups.map((g) => {
                const isCancelling = cancelBySeedMutation.isPending && cancelBySeedMutation.variables === g.seed_id
                return (
                  <div key={g.seed_id} className="px-3 py-1.5 flex items-center gap-3 group">
                    <span className="font-mono text-[10px] text-foreground/50 truncate flex-1">{g.seed_id}</span>
                    <span className="text-success">{g.success}</span>
                    <span className="text-foreground/40">/</span>
                    <span>{g.total}</span>
                    {g.fail > 0 && <span className="text-destructive">✗{g.fail}</span>}
                    {g.pending > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`取消该种子图下未完成的 ${g.pending} 条任务？\n（已成功/失败的记录会保留）`)) {
                            cancelBySeedMutation.mutate(g.seed_id)
                          }
                        }}
                        disabled={isCancelling}
                        title={`取消 ${g.pending} 条未完成任务`}
                        className="h-5 w-5 rounded inline-flex items-center justify-center text-foreground/35 hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )
              })}
              {seedGroups.length === 0 && (
                <div className="text-center py-6 text-[11px] text-foreground/40">暂无 subtask</div>
              )}
            </div>
          </section>

          {/* Failed list + actions */}
          {failed.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2 gap-2">
                <h3 className="text-[12px] font-medium text-foreground/70">失败清单 ({failed.length})</h3>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => retryMutation.mutate()}
                    disabled={retryMutation.isPending}
                    title="把所有失败任务重置为 pending 并继续执行"
                  >
                    <RotateCcw size={11} className={`mr-1 ${retryMutation.isPending ? 'animate-spin' : ''}`} />
                    {retryMutation.isPending ? '重试中…' : retried != null ? `已重置 ${retried}` : '重试全部失败'}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={exportFailedCsv}>
                    <Download size={11} className="mr-1" /> 导出 CSV
                  </Button>
                </div>
              </div>

              {/* Aggregated error banners (top 2 buckets) */}
              {errorBuckets.slice(0, 2).map((bucket) => (
                <ErrorBanner
                  key={bucket.key}
                  bucket={bucket}
                  onOpenProvider={openProviderSettings}
                />
              ))}

              <div className="rounded-md border border-destructive/20 max-h-[180px] overflow-y-auto divide-y divide-foreground/5 text-[11px]">
                {failed.slice(0, 100).map((s) => (
                  <div key={s.id} className="px-3 py-1.5 group">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-foreground/50">{s.id.slice(0, 8)}</span>
                      <span className="text-foreground/65">{promptsById.get(s.prompt_id)?.name || s.prompt_id.slice(0, 8)}</span>
                      <span className="ml-auto text-foreground/40">retry: {s.retry_count}</span>
                      {s.error_message && (
                        <button
                          className="text-foreground/35 hover:text-foreground/75 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => {
                            navigator.clipboard.writeText(`subtask=${s.id}\nseed=${s.seed_image_id}\nprompt=${s.prompt_id}\nretry=${s.retry_count}\nerror=${s.error_message}`)
                            toast.success('已复制错误详情')
                          }}
                          title="复制完整错误信息"
                        >
                          <Copy size={10} />
                        </button>
                      )}
                    </div>
                    {s.error_message && (
                      <div className="mt-1 text-destructive/80 line-clamp-2 select-text" title={s.error_message}>
                        {s.error_message}
                      </div>
                    )}
                  </div>
                ))}
                {failed.length > 100 && (
                  <div className="px-3 py-2 text-[10px] text-foreground/40">仅显示前 100 条；全部条目请导出 CSV</div>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </DetailDrawer>
  )
}

// ── Error aggregation ────────────────────────────────────────────────────────

type ErrorCategory = 'not-found' | 'auth' | 'rate-limit' | 'budget' | 'other'

interface ErrorBucket {
  key: string
  category: ErrorCategory
  sample: string
  count: number
  hint: string
  action?: 'open-provider'
}

function classifyError(msg: string): { category: ErrorCategory; key: string; hint: string; action?: 'open-provider' } {
  const m = (msg || '').toLowerCase()
  if (/\b404\b|not\s*found/.test(m)) {
    // Try to surface the specific path so different 404s don't collapse.
    const path = msg.match(/\/v\d+\/[A-Za-z0-9/_-]+/)?.[0] ?? ''
    return {
      category: 'not-found',
      key: `404:${path}`,
      hint: '模型路径或服务商接口不存在，可能是 base_url / 模型名配置错误',
      action: 'open-provider',
    }
  }
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid.*api.*key|api.*key.*invalid/.test(m)) {
    return {
      category: 'auth',
      key: 'auth',
      hint: 'API 鉴权失败，检查 API Key 是否正确、是否过期',
      action: 'open-provider',
    }
  }
  if (/\b429\b|rate.?limit|too\s*many/.test(m)) {
    return {
      category: 'rate-limit',
      key: 'rate-limit',
      hint: '触发限流，可降低并发数或稍后重试',
    }
  }
  if (/budget|quota|insufficient/.test(m)) {
    return {
      category: 'budget',
      key: 'budget',
      hint: '预算或配额不足，调整批次预算或充值后重试',
      action: 'open-provider',
    }
  }
  return { category: 'other', key: `other:${msg.slice(0, 60)}`, hint: '' }
}

function bucketErrors(failed: BatchSubtaskRecord[]): ErrorBucket[] {
  const map = new Map<string, ErrorBucket>()
  for (const s of failed) {
    const msg = s.error_message || ''
    const { category, key, hint, action } = classifyError(msg)
    const cur = map.get(key)
    if (cur) {
      cur.count += 1
    } else {
      map.set(key, { key, category, sample: msg, count: 1, hint, action })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

function ErrorBanner({ bucket, onOpenProvider }: { bucket: ErrorBucket; onOpenProvider: () => void }) {
  const copy = () => {
    navigator.clipboard.writeText(bucket.sample).then(
      () => toast.success('已复制错误信息'),
      () => toast.error('复制失败'),
    )
  }
  return (
    <div className="mb-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[11px]">
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} className="text-warning shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-foreground/85">
            <span className="font-medium">{bucket.count} 条</span>
            <span className="text-foreground/55"> 同类失败</span>
            {bucket.hint && <span className="text-foreground/65"> · {bucket.hint}</span>}
          </div>
          <div className="text-[10px] text-foreground/50 mt-1 truncate font-mono" title={bucket.sample}>
            {bucket.sample}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {bucket.action === 'open-provider' && (
            <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={onOpenProvider}>
              <ExternalLink size={10} className="mr-1" /> Provider 设置
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-foreground/55" onClick={copy} title="复制错误">
            <Copy size={11} />
          </Button>
        </div>
      </div>
    </div>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'destructive' }) {
  const color =
    tone === 'success' ? 'text-success' :
    tone === 'destructive' ? 'text-destructive' :
    'text-foreground/85'
  return (
    <div className="rounded-md bg-foreground/[0.025] px-3 py-2 flex items-center justify-between">
      <span className="text-foreground/50">{label}</span>
      <span className={`${color} font-medium tabular-nums`}>{value}</span>
    </div>
  )
}
