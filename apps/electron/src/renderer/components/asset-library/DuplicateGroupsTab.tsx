import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ArrowRight, Check, CheckCircle2, Crown, ExternalLink, Loader2, Scissors, Split, Trash2 } from 'lucide-react'

type GroupTab = 'pending' | 'done' | 'all'

interface SimilarGroupRow {
  id: string
  image_count: number
  pending_count?: number
  avg_hamming_distance: number
  members: Array<{
    id: string
    file_name: string
    width: number | null
    height: number | null
    blur_score: number | null
    is_kept: boolean
    thumbnail_url: string
  }>
}

// ── Similarity score display ────────────────────────────────────────────────
//
// We store the raw Hamming distance (lower = more similar). Most users don't
// know what a Hamming distance is, so we surface a human label + keep the
// number in a monospaced footnote. Thresholds derived from the dedup engine's
// default phash_threshold=10 (strict) and observed clusters up to ~30.
function similarityLabel(d: number): { label: string; tone: 'strong' | 'high' | 'mid' | 'low' } {
  if (d <= 5)  return { label: '几乎一样', tone: 'strong' }
  if (d <= 12) return { label: '极相似',   tone: 'strong' }
  if (d <= 20) return { label: '很相似',   tone: 'high' }
  if (d <= 28) return { label: '相似',     tone: 'mid' }
  return         { label: '略相似',        tone: 'low' }
}

export function DuplicateGroupsTab() {
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [minGroupSize, setMinGroupSize] = useState(2)
  const [tab, setTab] = useState<GroupTab>('pending')

  const { data, isLoading } = useQuery({
    queryKey: ['duplicate-groups', projectId],
    queryFn: () => (projectId ? api.images.listDuplicateGroups(projectId, 0, 500) : Promise.resolve({ total: 0, items: [] })),
    enabled: !!projectId,
    refetchInterval: 10_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['duplicate-groups'] })
    queryClient.invalidateQueries({ queryKey: ['images'] })
  }

  const setKept = useMutation({
    mutationFn: ({ groupId, imageId }: { groupId: string; imageId: string }) =>
      api.images.setKeptImage(groupId, imageId),
    onSuccess: () => { toast.success('已切换保留图') ; invalidate() },
    onError: (e: Error) => toast.error(e.message),
  })
  const dissolve = useMutation({
    mutationFn: (groupId: string) => api.images.dissolveGroup(groupId),
    onSuccess: () => { toast.success('已解除分组 · 全部视为独立图'); invalidate() },
  })
  const removeMember = useMutation({
    mutationFn: ({ groupId, imageId }: { groupId: string; imageId: string }) =>
      api.images.removeFromGroup(groupId, imageId),
    onSuccess: () => { toast.success('已从组中移出 · 该图视为独立图'); invalidate() },
  })
  const acceptAll = useMutation({
    mutationFn: (n: number | undefined) => api.images.acceptAllDuplicates(projectId!, n),
    onSuccess: ({ moved_to_trash }) => {
      toast.success(`已送 ${moved_to_trash.toLocaleString()} 张副本进回收站`, {
        description: '可在「回收站」标签二次确认或恢复',
      })
      invalidate()
    },
    onError: (e: Error) => toast.error(`操作失败：${e.message}`),
  })
  const acceptGroup = useMutation({
    mutationFn: (groupId: string) => api.images.acceptGroup(groupId),
    onSuccess: ({ moved_to_trash }) => {
      toast.success(`已送 ${moved_to_trash} 张副本进回收站`)
      invalidate()
    },
  })

  // ⚠️ All hooks MUST run on every render — keep useMemo BEFORE any early
  // return, otherwise React throws "Rendered more hooks than during the
  // previous render" and the page goes white.
  const items: SimilarGroupRow[] = (data?.items ?? []) as any
  const sizeFiltered = useMemo(
    () => items.filter((g) => g.image_count >= minGroupSize),
    [items, minGroupSize],
  )
  const pendingGroups = useMemo(
    () => sizeFiltered.filter((g) => (g.pending_count ?? Math.max(0, g.image_count - 1)) > 0),
    [sizeFiltered],
  )
  const doneGroups = useMemo(
    () => sizeFiltered.filter((g) => (g.pending_count ?? Math.max(0, g.image_count - 1)) === 0 && g.image_count > 1),
    [sizeFiltered],
  )

  const pendingCopies = sizeFiltered.reduce((s, g) => s + (g.pending_count ?? Math.max(0, g.image_count - 1)), 0)
  const archivedCopies = sizeFiltered.reduce(
    (s, g) => s + Math.max(0, (g.image_count - 1) - (g.pending_count ?? 0)),
    0,
  )

  const visibleGroups = tab === 'pending' ? pendingGroups : tab === 'done' ? doneGroups : sizeFiltered

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-48 text-[13px] text-foreground/40">
        请先选择一个项目
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => <div key={i} className="h-32 rounded-lg bg-foreground/[0.03] animate-pulse" />)}
      </div>
    )
  }

  if (!data || data.items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-foreground/10 py-12 text-center text-[13px] text-foreground/40">
        没有检测到相似组。到<strong className="mx-1">流水线 → 去重</strong>跑一次去重再回来。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Header: counts + size filter ── */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-3 space-y-3">
        <div className="flex items-center gap-4 flex-wrap text-[12.5px]">
          <StatBlock
            label="待处理"
            count={pendingGroups.length}
            detail={pendingCopies > 0 ? `${pendingCopies.toLocaleString()} 张副本等待送回收站` : '已全部处理完'}
            tone={pendingGroups.length > 0 ? 'pending' : 'done'}
          />
          <span className="text-foreground/20">·</span>
          <StatBlock
            label="已处理"
            count={doneGroups.length}
            detail={archivedCopies > 0 ? `${archivedCopies.toLocaleString()} 张副本在回收站` : '—'}
            tone="muted"
          />

          <div className="ml-auto flex items-center gap-2">
            <label className="text-[11px] text-foreground/55">组大小 ≥</label>
            <select
              value={minGroupSize}
              onChange={(e) => setMinGroupSize(Number(e.target.value))}
              className="h-7 rounded-md border border-foreground/15 bg-background px-1.5 text-[11.5px]"
              title="只显示成员数达到此阈值的组"
            >
              <option value={2}>2 张</option>
              <option value={3}>3 张</option>
              <option value={5}>5 张</option>
              <option value={10}>10 张</option>
              <option value={20}>20 张</option>
            </select>
          </div>
        </div>

        {/* Batch action — only meaningful when there's pending work */}
        {pendingGroups.length > 0 && (
          <div className="flex items-center gap-3 pt-1 border-t border-foreground/5">
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={acceptAll.isPending}
              onClick={() => {
                if (
                  confirm(
                    `将 ${pendingCopies.toLocaleString()} 张副本（来自 ${pendingGroups.length.toLocaleString()} 个组，` +
                    `每组 ≥ ${minGroupSize} 张）送入回收站。\n\n` +
                    `每组会自动保留「组长」（按分辨率 × 清晰度评分最高的一张），其余送回收站。\n\n` +
                    `操作可在「回收站」标签撤销。继续？`,
                  )
                ) {
                  acceptAll.mutate(minGroupSize > 1 ? minGroupSize : undefined)
                }
              }}
            >
              {acceptAll.isPending
                ? <Loader2 size={12} className="mr-1 animate-spin" />
                : <Trash2 size={12} className="mr-1" />}
              处理全部 {pendingGroups.length} 组 · 送 {pendingCopies.toLocaleString()} 张进回收站
            </Button>
            <span className="text-[11px] text-foreground/45">
              建议先抽查几组确认无误；操作可在<strong className="text-foreground/65">回收站</strong>撤销
            </span>
          </div>
        )}
      </div>

      {/* ── Segmented tabs ── */}
      <div className="flex items-center gap-1 text-[12px]">
        <SegTab
          active={tab === 'pending'}
          tone="pending"
          onClick={() => setTab('pending')}
          label="待处理"
          count={pendingGroups.length}
          dot={pendingGroups.length > 0}
        />
        <SegTab
          active={tab === 'done'}
          tone="done"
          onClick={() => setTab('done')}
          label="已处理"
          count={doneGroups.length}
        />
        <SegTab
          active={tab === 'all'}
          tone="muted"
          onClick={() => setTab('all')}
          label="全部"
          count={sizeFiltered.length}
        />
      </div>

      {/* ── Empty states & group list ── */}
      {tab === 'pending' && pendingGroups.length === 0 ? (
        <DoneCelebration
          doneCount={doneGroups.length}
          archivedCount={archivedCopies}
          onSeeHistory={() => setTab('done')}
        />
      ) : visibleGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-foreground/10 py-10 text-center text-[13px] text-foreground/40">
          当前分类下没有组
        </div>
      ) : (
        <div className="space-y-3">
          {visibleGroups.map((g) => {
            const pending = g.pending_count ?? Math.max(0, g.image_count - 1)
            const isDone = pending === 0 && g.image_count > 1
            const sim = similarityLabel(g.avg_hamming_distance)
            return (
              <div
                key={g.id}
                className={cn(
                  'rounded-lg border p-3 space-y-2 transition-colors',
                  isDone
                    ? 'border-foreground/5 bg-foreground/[0.01] opacity-75'
                    : 'border-foreground/8',
                )}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {g.image_count} 张
                  </Badge>
                  <span
                    className={cn(
                      'text-[11px] tabular-nums',
                      sim.tone === 'strong' ? 'text-destructive'
                      : sim.tone === 'high' ? 'text-warning'
                      : 'text-foreground/50',
                    )}
                    title={`相似度分数（基于 pHash 汉明距离）：数值越小越相似，0 = 完全一样。当前 d=${g.avg_hamming_distance.toFixed(1)}。`}
                  >
                    相似度：{sim.label}
                    <span className="ml-1 text-foreground/35 font-mono text-[10px]">d={g.avg_hamming_distance.toFixed(1)}</span>
                  </span>
                  {isDone && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-success border-success/40">
                      <Check size={9} className="mr-0.5" /> 已清理副本
                    </Badge>
                  )}
                  <div className="ml-auto flex gap-1">
                    {!isDone && (
                      <Button
                        variant="default" size="sm" className="h-7 text-[11px]"
                        disabled={acceptGroup.isPending}
                        onClick={() => acceptGroup.mutate(g.id)}
                        title={`保留当前组长，将其余 ${pending} 张送入回收站（可在回收站撤销）`}
                      >
                        <Check size={12} className="mr-1" />
                        处理此组 · 送 {pending} 张进回收站
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm" className="h-7 text-[11px] text-foreground/60"
                      onClick={() => {
                        if (confirm(`解除此组的重复关系？${g.image_count} 张图都会视为独立图，不再被判为重复。`)) {
                          dissolve.mutate(g.id)
                        }
                      }}
                      title="解除分组：不再视为同一组重复，但图不会进回收站"
                    >
                      <Split size={12} className="mr-1" /> 不是重复
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                  {g.members.map((m) => {
                    const willTrash = !m.is_kept && !isDone
                    return (
                      <div
                        key={m.id}
                        className={cn(
                          'relative group rounded-md overflow-hidden border cursor-pointer transition-colors',
                          m.is_kept
                            ? 'border-success ring-1 ring-success/50'
                            : 'border-foreground/10 hover:border-foreground/30 opacity-65 hover:opacity-95',
                        )}
                        onClick={() => {
                          if (!m.is_kept) setKept.mutate({ groupId: g.id, imageId: m.id })
                        }}
                        title={m.is_kept ? '当前保留图' : '点击改为保留图（其余将进回收站）'}
                      >
                        <img
                          src={`http://localhost:7879${m.thumbnail_url}`}
                          alt={m.file_name}
                          className="w-full aspect-square object-cover bg-foreground/[0.04]"
                          loading="lazy"
                        />
                        {m.is_kept ? (
                          <div className="absolute top-1 left-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-success text-white text-[9px] font-medium">
                            <Crown size={9} /> 保留
                          </div>
                        ) : willTrash ? (
                          <div className="absolute top-1 left-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-destructive/80 text-white text-[9px] font-medium">
                            <ArrowRight size={9} /> 回收站
                          </div>
                        ) : null}
                        <button
                          className="absolute top-1 right-1 w-5 h-5 rounded-sm bg-black/50 hover:bg-destructive text-white text-[10px] opacity-0 group-hover:opacity-100 flex items-center justify-center"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeMember.mutate({ groupId: g.id, imageId: m.id })
                          }}
                          title="从组中移出 · 视为独立图（不算副本，不进回收站）"
                        >
                          <Scissors size={10} />
                        </button>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 text-[9px] text-white/90">
                          <div className="truncate">{m.file_name}</div>
                          <div className="flex justify-between text-white/60 mt-0.5">
                            <span>{m.width}×{m.height}</span>
                            <span title="清晰度分数，数值越高越清晰">
                              {m.blur_score != null ? m.blur_score.toFixed(0) : '—'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatBlock({
  label, count, detail, tone,
}: {
  label: string
  count: number
  detail: string
  tone: 'pending' | 'done' | 'muted'
}) {
  const color =
    tone === 'pending' ? (count > 0 ? 'text-destructive' : 'text-success')
    : tone === 'done'  ? 'text-success'
    : 'text-foreground/55'
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-foreground/55">{label}</span>
      <span className={cn('font-semibold tabular-nums text-[14px]', color)}>
        {count.toLocaleString()}
      </span>
      <span className="text-foreground/45 text-[11px]">组</span>
      <span className="text-foreground/30 text-[11px] ml-1">· {detail}</span>
    </div>
  )
}

function SegTab({
  active, label, count, onClick, tone, dot,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
  tone: 'pending' | 'done' | 'muted'
  dot?: boolean
}) {
  const activeColor =
    tone === 'pending' ? 'border-destructive/50 text-destructive bg-destructive/5'
    : tone === 'done'  ? 'border-success/40 text-success bg-success/5'
    : 'border-foreground/25 text-foreground/85 bg-foreground/[0.04]'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border transition-colors',
        active ? activeColor : 'border-transparent text-foreground/55 hover:bg-foreground/[0.03]',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums font-medium">{count.toLocaleString()}</span>
      {dot && !active && (
        <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
      )}
    </button>
  )
}

function DoneCelebration({
  doneCount, archivedCount, onSeeHistory,
}: {
  doneCount: number
  archivedCount: number
  onSeeHistory: () => void
}) {
  const openTrash = () => {
    // Trash is a sub-tab of the asset library — emit a query param-free
    // navigation hint via a simple custom event. We avoid depending on
    // the library shell here; the parent already subscribes in
    // AssetLibrary.tsx to 'lintu:open-trash'.
    window.dispatchEvent(new CustomEvent('lintu:open-trash'))
  }
  return (
    <div className="rounded-xl border border-success/30 bg-success/[0.04] p-6 text-center space-y-3">
      <div className="inline-flex items-center gap-2 text-success">
        <CheckCircle2 size={20} />
        <span className="text-[14px] font-semibold">本轮重复清理已完成</span>
      </div>
      <p className="text-[12px] text-foreground/55">
        {doneCount.toLocaleString()} 组已处理 · 共
        <strong className="text-foreground/80 mx-1">{archivedCount.toLocaleString()}</strong>
        张副本在回收站
      </p>
      <div className="flex items-center justify-center gap-2 pt-1">
        <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={openTrash}>
          <ExternalLink size={12} className="mr-1" /> 打开回收站
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={onSeeHistory}>
          查看已处理 {doneCount} 组
        </Button>
      </div>
    </div>
  )
}
