import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CloudDownload, Loader2, RefreshCw, EyeOff, Eye } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { apiFetchRaw } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * OSS 图库 —— 把「OSS bucket 里的全部图」呈现出来,并把库外图导入灵图库。
 *
 * UGC 需求(2026-06):bucket 里有库外图(外部直传)。运营在这里:
 *   - 看到 bucket 全量(已入库 / 库外未导入 各多少)
 *   - 一键导入库外图(→ 待审核 + 未上架,自动入 embed/tag 管线)
 *   - 对已入库的图直接 上架 / 下架(决定是否进 UGC 匹配候选池)
 * 导入 + 审核通过 + 上架 后,该图即可被 UGC 的 match 接口匹配到。
 */

interface OssScanItem {
  object_key: string
  in_library: boolean
  image_id?: string
  review_status?: string
  is_listed?: boolean
  source_type?: string
  preview_url?: string
}
interface OssScanResult {
  configured: boolean
  total_objects: number
  in_library: number
  orphans: number
  items: OssScanItem[]
  items_capped?: boolean
}

export function OssLibraryDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  projectId: string | null
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'orphan' | 'in_library'>('all')

  const scan = useQuery<OssScanResult>({
    queryKey: ['oss-library-scan'],
    queryFn: async () => {
      const res = await apiFetchRaw('/oss-library/scan')
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    enabled: open,
    staleTime: 30_000,
  })

  const importAll = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw('/oss-library/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<{ imported: number; failed: number }>
    },
    onSuccess: (r) => {
      toast.success(`已导入 ${r.imported} 张库外图（待审核），失败 ${r.failed} 张。已派发向量+打标任务，处理完成后到「审核」上架即可参与匹配。`)
      scan.refetch()
    },
    onError: (e) => toast.error(`导入失败：${(e as Error).message.slice(0, 160)}`),
  })

  const setListing = useMutation({
    mutationFn: async ({ ids, listed }: { ids: string[]; listed: boolean }) => {
      const res = await apiFetchRaw('/images/batch/listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids, is_listed: listed }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: (_d, v) => {
      toast.success(v.listed ? '已上架' : '已下架')
      scan.refetch()
      queryClient.invalidateQueries({ queryKey: ['images'] })
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message.slice(0, 120)}`),
  })

  const data = scan.data
  const items = useMemo(() => {
    const all = data?.items ?? []
    if (filter === 'orphan') return all.filter((i) => !i.in_library)
    if (filter === 'in_library') return all.filter((i) => i.in_library)
    return all
  }, [data, filter])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload size={16} className="text-accent" />
            OSS 图库
          </DialogTitle>
          <DialogDescription>
            OSS bucket 里的全部图片。库外图导入后默认「待审核 + 未上架」，
            审核通过并上架后才会进入 UGC 匹配候选池。
          </DialogDescription>
        </DialogHeader>

        {!data && scan.isLoading && (
          <div className="py-12 text-center text-foreground/40 text-[13px]">
            <Loader2 className="inline animate-spin mr-2" size={14} /> 正在扫描 bucket…
          </div>
        )}

        {data && !data.configured && (
          <div className="py-12 text-center text-foreground/45 text-[13px]">
            OSS 未配置。请先到 设置 → OSS 连接 配置 bucket 凭据。
          </div>
        )}

        {data && data.configured && (
          <>
            {/* 汇总卡片 */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="bucket 总图数" value={data.total_objects} />
              <StatCard label="已入库" value={data.in_library} tone="ok" />
              <StatCard label="库外未导入" value={data.orphans} tone={data.orphans > 0 ? 'warn' : 'muted'} />
            </div>

            {/* 操作条 */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                disabled={!projectId || data.orphans === 0 || importAll.isPending}
                onClick={() => importAll.mutate()}
                title={!projectId ? '请先选择项目' : ''}
              >
                {importAll.isPending
                  ? <Loader2 size={13} className="animate-spin mr-1.5" />
                  : <CloudDownload size={13} className="mr-1.5" />}
                导入全部库外图片（{data.orphans}）
              </Button>
              <Button variant="outline" size="sm" onClick={() => scan.refetch()} disabled={scan.isFetching}>
                <RefreshCw size={13} className={cn('mr-1.5', scan.isFetching && 'animate-spin')} />
                重新扫描
              </Button>
              <div className="ml-auto flex items-center gap-1 text-[11px]">
                {(['all', 'orphan', 'in_library'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={cn('px-2 py-1 rounded',
                      filter === f ? 'bg-accent/15 text-accent' : 'text-foreground/50 hover:bg-foreground/5')}
                  >
                    {f === 'all' ? '全部' : f === 'orphan' ? '库外' : '已入库'}
                  </button>
                ))}
              </div>
            </div>

            {data.items_capped && (
              <div className="text-[11px] text-foreground/40">
                对象较多，下面只预览前 {data.items.length} 条；「导入全部库外图片」会处理全部 {data.orphans} 张。
              </div>
            )}

            {/* 缩略图网格 */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2 max-h-[46vh] overflow-y-auto pr-1">
              {items.map((it) => (
                <div key={it.object_key} className="relative group rounded-md overflow-hidden border border-foreground/8 bg-foreground/[0.03]" style={{ aspectRatio: '1' }}>
                  {it.preview_url && (
                    <img src={it.preview_url} alt={it.object_key} loading="lazy"
                      className="w-full h-full object-cover" />
                  )}
                  {/* 状态角标 */}
                  <div className="absolute top-1 left-1 flex flex-col gap-0.5 items-start">
                    {!it.in_library ? (
                      <span className="text-[9px] px-1 rounded bg-amber-500/85 text-white">库外</span>
                    ) : (
                      <>
                        <span className={cn('text-[9px] px-1 rounded text-white',
                          it.review_status === 'approved' ? 'bg-emerald-500/85'
                            : it.review_status === 'rejected' ? 'bg-rose-500/85' : 'bg-foreground/55')}>
                          {it.review_status === 'approved' ? '已审' : it.review_status === 'rejected' ? '拒' : '待审'}
                        </span>
                        <span className={cn('text-[9px] px-1 rounded text-white',
                          it.is_listed ? 'bg-accent/85' : 'bg-foreground/45')}>
                          {it.is_listed ? '已上架' : '未上架'}
                        </span>
                      </>
                    )}
                  </div>
                  {/* hover 上架/下架 */}
                  {it.in_library && it.image_id && (
                    <button
                      onClick={() => setListing.mutate({ ids: [it.image_id!], listed: !it.is_listed })}
                      disabled={setListing.isPending}
                      className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity
                                 bg-background/90 rounded px-1 py-0.5 text-[10px] flex items-center gap-0.5 shadow"
                      title={it.is_listed ? '下架' : '上架'}
                    >
                      {it.is_listed
                        ? <><EyeOff size={10} /> 下架</>
                        : <><Eye size={10} /> 上架</>}
                    </button>
                  )}
                </div>
              ))}
              {items.length === 0 && (
                <div className="col-span-full py-8 text-center text-foreground/35 text-[12px]">
                  该筛选下没有对象
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function StatCard({ label, value, tone = 'muted' }: { label: string; value: number; tone?: 'ok' | 'warn' | 'muted' }) {
  return (
    <div className="rounded-lg border border-foreground/8 px-3 py-2.5">
      <div className="text-[11px] text-foreground/50">{label}</div>
      <div className={cn('text-[22px] font-semibold tabular-nums mt-0.5',
        tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400'
          : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/80')}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
