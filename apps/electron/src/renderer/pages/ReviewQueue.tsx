import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, CheckSquare, ChevronRight, ClipboardCheck, Loader2, SkipForward, X } from 'lucide-react'

import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/EmptyState'
import { Skeleton } from '@/components/shared/Skeleton'
import { cn } from '@/lib/utils'
import { api, apiFetchRaw } from '@/lib/api'

type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'skipped'

interface ReviewItem {
  id: string
  project_id: string
  file_name: string
  width: number | null
  height: number | null
  blur_score: number | null
  parent_id: string | null
  review_status: ReviewStatus
  reviewed_at: string | null
  source_type?: string | null
  source_channel?: string | null
  upload_batch_id?: string | null
  missing_dims?: string[]
  tags_complete?: boolean
  generation_metadata: Record<string, unknown> | null
  created_at: string | null
}

// 必填维度键 → 中文,给"标签未齐"提示用
const DIM_LABEL: Record<string, string> = {
  scene: '场景', season: '季节', weather: '天气', angle: '视角', people: '人物',
}

interface BatchItem {
  id: string
  batch_no: string
  source_channel: string
  uploaded_by_name: string | null
  note: string | null
  total: number
  counts: Record<string, number>
}

interface QueueResponse {
  total: number
  offset: number
  limit: number
  items: ReviewItem[]
}

const TABS: { id: ReviewStatus; label: string }[] = [
  { id: 'pending',  label: '待审核' },
  { id: 'approved', label: '已通过' },
  { id: 'rejected', label: '已拒绝' },
  { id: 'skipped',  label: '已跳过' },
]

export default function ReviewQueue() {
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ReviewStatus>('pending')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 60

  const queueQuery = useQuery<QueueResponse>({
    queryKey: ['review-queue', projectId, status, page],
    queryFn: () =>
      apiFetchRaw(
        `/image-review/queue?status=${status}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}` +
        (projectId ? `&project_id=${projectId}` : ''),
      ).then((r) => r.json()),
    enabled: !!projectId,
    refetchInterval: 30_000,
  })

  const countsQuery = useQuery<Record<string, number>>({
    queryKey: ['review-counts', projectId],
    queryFn: () =>
      apiFetchRaw(`/image-review/counts${projectId ? `?project_id=${projectId}` : ''}`)
        .then((r) => r.json()),
    enabled: !!projectId,
    refetchInterval: 30_000,
  })

  const decide = useMutation({
    mutationFn: async ({ ids, decision }: { ids: string[]; decision: ReviewStatus }) => {
      const res = await apiFetchRaw(`/image-review/decide`, {
        method: 'POST',
        body: JSON.stringify({ image_ids: ids, decision }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{ ok: boolean; updated: number }>
    },
    onSuccess: (result, { decision }) => {
      const verbLabel = decision === 'approved' ? '通过' : decision === 'rejected' ? '拒绝' : '跳过'
      toast.success(`已${verbLabel} ${result.updated} 张`)
      setSelected(new Set())
      queryClient.invalidateQueries({ queryKey: ['review-queue'] })
      queryClient.invalidateQueries({ queryKey: ['review-counts'] })
      queryClient.invalidateQueries({ queryKey: ['review-batches'] })
    },
    onError: (e: any) => toast.error(`操作失败：${e?.message ?? e}`),
  })

  // 上传批次(整批审核用)。只在「待审核」Tab 拉。
  const batchesQuery = useQuery<{ items: BatchItem[] }>({
    queryKey: ['review-batches', projectId],
    queryFn: () =>
      apiFetchRaw(`/image-review/batches${projectId ? `?project_id=${projectId}` : ''}`).then((r) => r.json()),
    enabled: !!projectId && status === 'pending',
    refetchInterval: 30_000,
  })

  const batchDecide = useMutation({
    mutationFn: async ({ batchId, decision }: { batchId: string; decision: ReviewStatus }) => {
      const res = await apiFetchRaw(`/image-review/batch-decide`, {
        method: 'POST',
        body: JSON.stringify({ upload_batch_id: batchId, decision }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{ ok: boolean; updated: number }>
    },
    onSuccess: (result, { decision }) => {
      toast.success(`整批已${decision === 'approved' ? '通过' : '退回'}（${result.updated} 张）`)
      queryClient.invalidateQueries({ queryKey: ['review-queue'] })
      queryClient.invalidateQueries({ queryKey: ['review-counts'] })
      queryClient.invalidateQueries({ queryKey: ['review-batches'] })
    },
    onError: (e: any) => toast.error(`整批操作失败：${e?.message ?? e}`),
  })

  const items = queueQuery.data?.items ?? []
  const total = queueQuery.data?.total ?? 0
  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id))
  const selectedCount = selected.size
  const selectedOnPageCount = items.filter((it) => selected.has(it.id)).length

  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const toggleAll = () => {
    // 选中状态跨页保留：运营可以在多页里挑图，最后一次性批量审核。
    // 因此「全选本页」只增删当前页，不应该清空其他页已选的图片。
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) items.forEach((it) => next.delete(it.id))
      else items.forEach((it) => next.add(it.id))
      return next
    })
  }

  const onDecide = (decision: ReviewStatus, scope: 'selected' | 'all') => {
    if (decide.isPending) return
    const ids = scope === 'selected' ? Array.from(selected) : items.map((it) => it.id)
    if (ids.length === 0) {
      toast.error('请先选择图片')
      return
    }
    // 批量拒绝不可撤销:>1 张时二次确认,防误触一次毙掉一屏图。
    if (decision === 'rejected' && ids.length > 1) {
      const ok = window.confirm(`确定拒绝选中的 ${ids.length} 张图片？拒绝后将移出审核队列，不可批量撤销。`)
      if (!ok) return
    }
    decide.mutate({ ids, decision })
  }

  if (!projectId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={ClipboardCheck}
          title="未选择项目"
          description="先在左上角项目下拉里选一个项目，再来审核 AI 生成图"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between gap-4 px-5 h-[40px] shrink-0 border-b border-foreground/5">
        <div className="flex items-center gap-5">
          <h1 className="text-[13px] font-semibold text-foreground/85">审核队列</h1>
          <div className="flex items-center gap-1 bg-foreground/[0.04] rounded-md p-0.5">
            {TABS.map((t) => {
              const count = countsQuery.data?.[t.id] ?? 0
              const isActive = status === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => { setStatus(t.id); setPage(0); setSelected(new Set()) }}
                  className={cn(
                    'px-2.5 py-1 text-[11.5px] rounded transition-colors flex items-center gap-1.5',
                    isActive
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-foreground/55 hover:text-foreground/85',
                  )}
                >
                  {t.label}
                  {count > 0 && (
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full leading-none tabular-nums',
                        isActive ? 'bg-accent/15 text-accent' : 'bg-foreground/[0.08] text-foreground/55',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {status === 'pending' && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={allSelected ? 'secondary' : 'outline'}
              onClick={toggleAll}
              disabled={items.length === 0 || decide.isPending}
              aria-pressed={allSelected}
              title={allSelected ? '取消选择当前页的全部图片' : '选择当前页的全部待审核图片'}
            >
              <CheckSquare size={12} className="mr-1.5" />
              {allSelected ? '取消本页全选' : `全选本页 (${items.length})`}
            </Button>
            {selectedCount > 0 && (
              <>
                <span className="text-[11px] text-foreground/55 mr-1">
                  已选 {selectedCount} 张{selectedCount > selectedOnPageCount ? '（含其他页）' : ''}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                  disabled={decide.isPending}
                  className="h-7 px-2 text-[11px] text-foreground/55"
                >
                  清空选择
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide('skipped', 'selected')}
              disabled={selectedCount === 0 || decide.isPending}
            >
              <SkipForward size={12} className="mr-1.5" />
              跳过
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDecide('rejected', 'selected')}
              disabled={selectedCount === 0 || decide.isPending}
              className="text-destructive hover:text-destructive"
            >
              <X size={12} className="mr-1.5" />
              拒绝
            </Button>
            <Button
              size="sm"
              onClick={() => onDecide('approved', 'selected')}
              disabled={selectedCount === 0 || decide.isPending}
            >
              {decide.isPending ? (
                <Loader2 size={12} className="animate-spin mr-1.5" />
              ) : (
                <Check size={12} className="mr-1.5" />
              )}
              通过
            </Button>
          </div>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {queueQuery.isLoading ? (
          <Skeleton.ImageGrid count={12} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            title={`没有${TABS.find((t) => t.id === status)?.label}的图`}
            description={
              status === 'pending'
                ? 'AI 工坊出新图后会自动进入这里等待审核'
                : '切到「待审核」Tab 看待办，或去 AI 工坊产新图'
            }
          />
        ) : (
          <>
            {status === 'pending' && (
              <div className="flex items-center gap-3 mb-3">
                <span className="text-[11.5px] text-foreground/40">
                  共 {total} 张待审核
                </span>
                <span className="text-[11.5px] text-foreground/45">
                  点击图片或右上角方框可多选
                </span>
                {selectedCount > 0 && (
                  <span className="text-[11.5px] text-accent">
                    本页已选 {selectedOnPageCount} 张，跨页共选 {selectedCount} 张
                  </span>
                )}
                {items.filter((it) => it.tags_complete === false).length > 0 && (
                  <span className="text-[11.5px] text-warning">
                    本页 {items.filter((it) => it.tags_complete === false).length} 张标签待补充（不阻塞 OSS 上传）
                  </span>
                )}
              </div>
            )}
            {status === 'pending' && (
              <BatchBar
                batches={(batchesQuery.data?.items ?? []).filter((b) => (b.counts?.pending ?? 0) > 0)}
                pending={batchDecide.isPending}
                onDecide={(batchId, decision) => {
                  if (decision === 'rejected' && !window.confirm('整批退回该上传批次的待审图？退回后移出候选池。')) return
                  batchDecide.mutate({ batchId, decision })
                }}
              />
            )}
            <ReviewGrid
              items={items}
              selected={selected}
              showCheckbox={status === 'pending'}
              onToggleSelect={toggleOne}
            />
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </div>
  )
}

function BatchBar({
  batches, pending, onDecide,
}: {
  batches: BatchItem[]
  pending: boolean
  onDecide: (batchId: string, decision: ReviewStatus) => void
}) {
  if (batches.length === 0) return null
  return (
    <div className="mb-4 rounded-lg border border-foreground/8 bg-foreground/[0.015] p-2.5">
      <div className="text-[11px] text-foreground/50 mb-2">按上传批次整批处理（{batches.length} 个待审批次）</div>
      <div className="flex flex-wrap gap-2">
        {batches.map((b) => (
          <div key={b.id} className="flex items-center gap-2 rounded-md border border-foreground/10 bg-background px-2 py-1.5">
            <div className="min-w-0">
              <div className="text-[11.5px] text-foreground/80 tabular-nums">{b.batch_no}</div>
              <div className="text-[10px] text-foreground/45 truncate max-w-[180px]">
                {b.source_channel}{b.uploaded_by_name ? ` · ${b.uploaded_by_name}` : ''} · 待审 {b.counts?.pending ?? 0}
                {b.note ? ` · ${b.note}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button size="sm" variant="outline" className="h-6 text-[11px] text-destructive"
                disabled={pending} onClick={() => onDecide(b.id, 'rejected')}>退回</Button>
              <Button size="sm" className="h-6 text-[11px]"
                disabled={pending} onClick={() => onDecide(b.id, 'approved')}>整批通过</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReviewGrid({
  items, selected, showCheckbox, onToggleSelect,
}: {
  items: ReviewItem[]
  selected: Set<string>
  showCheckbox: boolean
  onToggleSelect: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {items.map((it) => {
        const isSelected = selected.has(it.id)
        return (
          <div
            key={it.id}
            onClick={() => showCheckbox && onToggleSelect(it.id)}
            className={cn(
              'rounded-md overflow-hidden border transition-all',
              showCheckbox && 'cursor-pointer hover:border-accent/60',
              isSelected
                ? 'border-accent ring-2 ring-accent/30'
                : 'border-foreground/10',
            )}
          >
            <div className="relative bg-foreground/[0.04]" style={{ aspectRatio: '4/3' }}>
              <img
                src={api.images.thumbnailUrl(it.id, 300)}
                alt={it.file_name}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={(e) => {
                  // 缩略图可能还在后台生成,首次失败自动重试一次(加时间戳绕缓存);
                  // 再失败才淡化。比直接淡化少误伤"刚生成还没就绪"的图。
                  const el = e.target as HTMLImageElement
                  const tries = Number(el.dataset.retry || '0')
                  if (tries < 1) {
                    el.dataset.retry = String(tries + 1)
                    const base = api.images.thumbnailUrl(it.id, 300)
                    setTimeout(() => { el.src = base + (base.includes('?') ? '&' : '?') + 'r=' + Date.now() }, 1200)
                  } else {
                    el.style.opacity = '0.2'
                  }
                }}
              />
              {showCheckbox && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`${isSelected ? '取消选择' : '选择'} ${it.file_name}`}
                  title={isSelected ? '取消选择' : '选择用于批量审核'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleSelect(it.id)
                  }}
                  className={cn(
                    'absolute top-1.5 right-1.5 h-5 w-5 rounded border shadow flex items-center justify-center transition-colors',
                    isSelected
                      ? 'bg-accent border-accent text-accent-foreground'
                      : 'bg-background/90 border-foreground/30 text-transparent hover:border-accent/60',
                  )}
                >
                  <Check size={12} />
                </button>
              )}
            </div>
            <div className="px-2 py-1.5 space-y-0.5">
              <div className="text-[11px] text-foreground/75 truncate" title={it.file_name}>
                {it.file_name}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-foreground/45 flex-wrap">
                {it.width && it.height && <span>{it.width}×{it.height}</span>}
                {it.blur_score !== null && <span>blur {Math.round(it.blur_score)}</span>}
                {it.source_channel && (
                  <span className="px-1 rounded bg-accent/10 text-accent">{it.source_channel}</span>
                )}
                {!it.source_channel && it.source_type === 'generated' && (
                  <span className="px-1 rounded bg-foreground/10 text-foreground/50">AI</span>
                )}
                {it.tags_complete === false && (
                  <span
                    className="px-1 rounded bg-warning/15 text-warning"
                    title={`缺必填标签：${(it.missing_dims || []).map((d) => DIM_LABEL[d] || d).join('、')}`}
                  >
                    标签未齐
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Pager({
  page, pageSize, total, onPageChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (p: number) => void
}) {
  const pages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize])
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between mt-4 text-[11.5px] text-foreground/55">
      <span>
        第 {page + 1} 页 / 共 {pages} 页（每页 {pageSize}）
      </span>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={page >= pages - 1}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
          <ChevronRight size={12} />
        </Button>
      </div>
    </div>
  )
}
