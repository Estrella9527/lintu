import { useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronRight, ClipboardCheck, Loader2, SkipForward, X } from 'lucide-react'

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
  generation_metadata: Record<string, unknown> | null
  created_at: string | null
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
    },
    onError: (e: any) => toast.error(`操作失败：${e?.message ?? e}`),
  })

  const items = queueQuery.data?.items ?? []
  const total = queueQuery.data?.total ?? 0
  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id))
  const selectedCount = selected.size

  const toggleOne = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(items.map((it) => it.id)))
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
            {selectedCount > 0 && (
              <span className="text-[11px] text-foreground/55 mr-1">
                已选 {selectedCount} 张
              </span>
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
                <button
                  onClick={toggleAll}
                  className="text-[11.5px] text-foreground/65 hover:text-foreground/85"
                >
                  {allSelected ? '取消全选本页' : `全选本页 (${items.length})`}
                </button>
                <span className="text-[11.5px] text-foreground/40">
                  共 {total} 张待审核
                </span>
              </div>
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
              onPageChange={(p) => { setPage(p); setSelected(new Set()) }}
            />
          </>
        )}
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
              {showCheckbox && isSelected && (
                <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-accent text-accent-foreground flex items-center justify-center shadow">
                  <Check size={12} />
                </div>
              )}
            </div>
            <div className="px-2 py-1.5 space-y-0.5">
              <div className="text-[11px] text-foreground/75 truncate" title={it.file_name}>
                {it.file_name}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-foreground/45">
                {it.width && it.height && <span>{it.width}×{it.height}</span>}
                {it.blur_score !== null && <span>blur {Math.round(it.blur_score)}</span>}
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
