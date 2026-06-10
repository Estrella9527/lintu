import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check, Cloud, CloudDownload, Eye, EyeOff, Loader2, Minus, Plus, RefreshCw, Trash2,
} from 'lucide-react'

import { api, type OssObjectItem } from '@/lib/api'
import { cn } from '@/lib/utils'
import { InfoHint } from '@/components/shared/InfoHint'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { OssFolderTree } from './OssFolderTree'
import { ImageInspector } from './ImageInspector'
import type { ImageRecord } from '@/lib/types'

const PAGE = 120
const RH_MIN = 110, RH_MAX = 260, RH_STEP = 18

type OnlyFilter = 'all' | 'orphan' | 'cloud' | 'in_library'

/** "X 分钟前" 形式的相对时间(scanned_at 是 UTC naive ISO) */
function relTime(iso?: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso + 'Z').getTime()
  const min = Math.max(0, Math.floor(ms / 60000))
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/**
 * 资产库 → OSS 图库 Tab。把 bucket 全量图(库内 + 库外)按目录浏览,对齐本地
 * 资产库的三栏布局与交互:左目录树 / 中网格(状态角标 + 上架下架导入)/ 右详情。
 * 已入库对象复用 ImageInspector 展示完整图片信息;库外对象展示对象信息 + 导入。
 */
export function OssLibraryTab({ projectId }: { projectId: string | null }) {
  const queryClient = useQueryClient()
  const [folder, setFolder] = useState<string | null>(null) // null=全部目录;""=根;"i"=该目录
  const [only, setOnly] = useState<OnlyFilter>('all')
  const [rowHeight, setRowHeight] = useState(150)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<OssObjectItem | null>(null)

  // 默认走后端缓存(秒开);「重新扫描」走 refresh=true 真扫并刷新缓存
  const scan = useQuery({
    queryKey: ['oss-scan'],
    queryFn: () => api.ossLibrary.scan(),
    staleTime: 60_000,
  })

  const rescan = useMutation({
    mutationFn: () => api.ossLibrary.scan(true),
    onSuccess: (d) => {
      queryClient.setQueryData(['oss-scan'], d)
      queryClient.invalidateQueries({ queryKey: ['oss-objects'] })
      toast.success('已重新扫描 OSS 仓')
    },
    onError: (e: any) => toast.error(`扫描失败:${String(e?.message || e).slice(0, 120)}`),
  })

  const objectsQ = useInfiniteQuery({
    queryKey: ['oss-objects', folder, only],
    queryFn: ({ pageParam = 0 }) =>
      api.ossLibrary.objects({ prefix: folder, only, offset: pageParam as number, limit: PAGE }),
    getNextPageParam: (last, pages) =>
      last.items.length === PAGE ? pages.length * PAGE : undefined,
    initialPageParam: 0,
    enabled: scan.data?.configured !== false,
  })

  const items = useMemo(() => objectsQ.data?.pages.flatMap((p) => p.items) ?? [], [objectsQ.data])
  const total = objectsQ.data?.pages[0]?.total ?? 0

  const refreshAll = useCallback(() => {
    scan.refetch()
    queryClient.invalidateQueries({ queryKey: ['oss-objects'] })
  }, [scan, queryClient])

  const importAll = useMutation({
    mutationFn: () => api.ossLibrary.import(projectId!, undefined),
    onSuccess: (r) => {
      toast.success(`已导入 ${r.imported} 张库外图（待审核 + 未上架），失败 ${r.failed}。已派发向量+打标，处理后到「审核」上架即可参与匹配。`)
      refreshAll()
    },
    onError: (e: any) => toast.error(`导入失败：${String(e?.message || e).slice(0, 160)}`),
  })

  const importKeys = useMutation({
    mutationFn: (keys: string[]) => api.ossLibrary.import(projectId!, keys),
    onSuccess: (r) => { toast.success(`已导入 ${r.imported} 张`); setSelected(new Set()); refreshAll() },
    onError: (e: any) => toast.error(`导入失败：${String(e?.message || e).slice(0, 140)}`),
  })

  // OSS 文件删除:先弹确认(列明 未纳管直接删 / 已入库连记录删 / 云端跳过)
  const [confirmDel, setConfirmDel] = useState<{
    keys: string[]; nOrphan: number; nLocal: number; nCloud: number
  } | null>(null)

  const requestDelete = useCallback((its: OssObjectItem[]) => {
    if (!its.length) return
    setConfirmDel({
      keys: its.map((i) => i.object_key),
      nOrphan: its.filter((i) => i.status === 'orphan').length,
      nLocal: its.filter((i) => i.status === 'local').length,
      nCloud: its.filter((i) => i.status === 'cloud').length,
    })
  }, [])

  const deleteObjects = useMutation({
    mutationFn: (keys: string[]) => api.ossLibrary.deleteObjects(keys, true),
    onSuccess: (r) => {
      if (r.error) { toast.error(r.error); return }
      const parts = [`已删除 ${r.deleted_objects} 个文件`]
      if (r.deleted_records) parts.push(`含 ${r.deleted_records} 条图库记录(本地+云端)`)
      if (r.skipped_cloud) parts.push(`跳过 ${r.skipped_cloud} 个云端发布对象`)
      toast.success(parts.join(' · '))
      setConfirmDel(null)
      setSelected(new Set())
      setActive(null)
      queryClient.invalidateQueries({ queryKey: ['oss-scan'] })
      queryClient.invalidateQueries({ queryKey: ['oss-objects'] })
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['image-folders'] })
    },
    onError: (e: any) => toast.error(`删除失败：${String(e?.message || e).slice(0, 160)}`),
  })

  const setListing = useMutation({
    mutationFn: ({ ids, listed }: { ids: string[]; listed: boolean }) =>
      api.images.setListing(ids, listed),
    onSuccess: (_d, v) => {
      toast.success(v.listed ? '已上架' : '已下架')
      setSelected(new Set())
      refreshAll()
      queryClient.invalidateQueries({ queryKey: ['images'] })
    },
    onError: (e: any) => toast.error(`操作失败：${String(e?.message || e).slice(0, 120)}`),
  })

  // 选中集 → 拆成 已入库(可上下架) / 库外(可导入)
  const selectedItems = useMemo(
    () => items.filter((it) => selected.has(it.object_key)),
    [items, selected],
  )
  const selInLib = selectedItems.filter((i) => i.status === 'local' && i.image_id)
  const selOrphan = selectedItems.filter((i) => i.status === 'orphan')

  const toggleSelect = (key: string) => setSelected((prev) => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n
  })

  const data = scan.data

  if (data && !data.configured) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-foreground/40">
        OSS 未配置。请先到 设置 → OSS 连接 配置 bucket 凭据。
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex">
      {/* 左：目录树 + 状态筛选 */}
      <aside className="w-56 shrink-0 overflow-y-auto px-3 py-3 border-r border-foreground/5 space-y-4">
        <div>
          <h3 className="text-[11px] font-medium text-foreground/50 mb-2 px-1.5">按目录</h3>
          {scan.isLoading ? (
            <div className="space-y-1">{[1, 2, 3].map((i) => <div key={i} className="h-6 rounded bg-foreground/[0.04] animate-pulse" />)}</div>
          ) : (
            <OssFolderTree dirs={data?.dirs ?? []} selected={folder}
              onSelect={(f) => { setFolder(f); setSelected(new Set()) }} />
          )}
        </div>
        <div>
          <div className="flex items-center gap-1 mb-2 px-1.5">
            <h3 className="text-[11px] font-medium text-foreground/50">按状态</h3>
            <InfoHint text={
              '已入库(本机):这台电脑的灵图在管理,信息最全,可审核/上架/编辑。\n' +
              '云端已发布:其他电脑发布的,标签等信息直接显示远端数据;要在本机参与匹配,开 设置→通用→多设备同步。\n' +
              '未纳管:仓里只有文件,任何电脑都没导入过 — 「导入」后走打标→审核→上架。'
            } />
          </div>
          <div className="space-y-0.5">
            {([
              ['all', '全部', data?.total_objects],
              ['orphan', '未纳管（可导入）', data?.orphans],
              ['cloud', '云端已发布', data?.cloud],
              ['in_library', '已入库（本机）', data?.in_library],
            ] as [OnlyFilter, string, number | undefined][]).map(([f, label, n]) => (
              <button key={f} onClick={() => { setOnly(f); setSelected(new Set()) }}
                className={cn('w-full flex items-center gap-1 px-1.5 py-1 rounded text-left text-[12px] transition-colors',
                  only === f ? 'bg-accent/10 text-accent' : 'text-foreground/70 hover:bg-foreground/[0.03]')}>
                <span className="truncate flex-1">{label}</span>
                <span className={cn('text-[10px] tabular-nums', only === f ? 'text-accent/80' : 'text-foreground/35')}>
                  {(n ?? 0).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* 中：工具条 + 网格 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="sticky top-0 z-20 bg-background px-5 pt-3 pb-2 border-b border-foreground/5 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px] text-foreground/45">
              {selected.size > 0 ? `已选 ${selected.size} / ${total.toLocaleString()}` : `共 ${total.toLocaleString()} 张`}
            </span>
            <Button
              disabled={!projectId || (data?.orphans ?? 0) === 0 || importAll.isPending}
              onClick={() => importAll.mutate()}
              title={!projectId ? '请先选择项目' : ''}>
              {importAll.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : <CloudDownload size={12} className="mr-1" />}
              导入全部未纳管（{(data?.orphans ?? 0).toLocaleString()}）
            </Button>
            <button onClick={() => rescan.mutate()} disabled={rescan.isPending}
              className="flex items-center gap-1 px-2 py-1 text-[12px] rounded text-foreground/65 hover:bg-foreground/[0.05] disabled:opacity-50">
              <RefreshCw size={12} className={cn(rescan.isPending && 'animate-spin')} /> 重新扫描
            </button>
            {data?.scanned_at && (
              <span className="text-[11px] text-foreground/35">
                {rescan.isPending ? '扫描中…' : `上次扫描 ${relTime(data.scanned_at)}`}
              </span>
            )}

            {/* 行高缩放 */}
            <div className="ml-auto flex items-center gap-1.5 text-foreground/45">
              <button onClick={() => setRowHeight((h) => Math.max(RH_MIN, h - RH_STEP))} className="h-6 w-6 rounded hover:bg-foreground/[0.05] flex items-center justify-center"><Minus size={12} /></button>
              <input type="range" min={RH_MIN} max={RH_MAX} step={RH_STEP} value={rowHeight}
                onChange={(e) => setRowHeight(Number(e.target.value))} className="w-20 h-1 accent-accent" />
              <button onClick={() => setRowHeight((h) => Math.min(RH_MAX, h + RH_STEP))} className="h-6 w-6 rounded hover:bg-foreground/[0.05] flex items-center justify-center"><Plus size={12} /></button>
            </div>
          </div>

          {/* 批量操作条 */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/[0.04] px-3 py-1.5 text-[12px]">
              <span className="text-foreground/65">已选 {selected.size} 张</span>
              {selOrphan.length > 0 && (
                <Button onClick={() => importKeys.mutate(selOrphan.map((i) => i.object_key))} disabled={!projectId || importKeys.isPending}>
                  <CloudDownload size={12} className="mr-1" /> 导入库外（{selOrphan.length}）
                </Button>
              )}
              {selInLib.length > 0 && <>
                <Button onClick={() => setListing.mutate({ ids: selInLib.map((i) => i.image_id!), listed: true })} disabled={setListing.isPending}>
                  <Eye size={12} className="mr-1" /> 上架（{selInLib.length}）
                </Button>
                <Button onClick={() => setListing.mutate({ ids: selInLib.map((i) => i.image_id!), listed: false })} disabled={setListing.isPending}>
                  <EyeOff size={12} className="mr-1" /> 下架（{selInLib.length}）
                </Button>
              </>}
              {(selOrphan.length > 0 || selInLib.length > 0) && (
                <button
                  onClick={() => requestDelete(selectedItems)}
                  disabled={deleteObjects.isPending}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] rounded-md border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-40">
                  <Trash2 size={12} /> 删除文件（{selOrphan.length + selInLib.length}）
                </button>
              )}
              <button onClick={() => setSelected(new Set())} className="ml-auto text-foreground/45 hover:text-foreground/70">清除</button>
            </div>
          )}
        </div>

        {/* 网格 */}
        <div className="px-5 pt-3 pb-4">
          {objectsQ.isLoading ? (
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 18 }).map((_, i) => (
                <div key={i} className="rounded-md bg-foreground/[0.03] animate-pulse" style={{ width: rowHeight, height: rowHeight }} />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-foreground/35 text-[13px]">该筛选下没有对象</div>
          ) : (
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${rowHeight}px, 1fr))` }}>
              {items.map((it) => (
                <OssCell key={it.object_key} item={it} height={rowHeight}
                  selected={selected.has(it.object_key)} active={active?.object_key === it.object_key}
                  onToggleSelect={() => toggleSelect(it.object_key)}
                  onClick={() => setActive(it)}
                  onListing={(listed) => it.image_id && setListing.mutate({ ids: [it.image_id], listed })}
                  onImport={() => projectId && importKeys.mutate([it.object_key])}
                  onDelete={() => requestDelete([it])}
                  busy={setListing.isPending || importKeys.isPending || deleteObjects.isPending} />
              ))}
            </div>
          )}
          {objectsQ.hasNextPage && <LoadMore onVisible={() => objectsQ.fetchNextPage()} />}
        </div>
      </div>

      {/* 右：详情 — 本机(完整可编辑) / 云端(远端只读信息) / 未纳管(导入入口) */}
      {active?.status === 'local' && active.image_id ? (
        <ImageInspector image={{ id: active.image_id } as ImageRecord} />
      ) : active?.status === 'cloud' && active.image_id ? (
        <CloudImageInspector item={active} />
      ) : (
        <OssOrphanInspector item={active} projectId={projectId}
          onImport={() => active && projectId && importKeys.mutate([active.object_key])}
          onDelete={() => active && requestDelete([active])}
          importing={importKeys.isPending} />
      )}

      {/* 删除确认 — 列明三类影响,防误删 */}
      <Dialog open={!!confirmDel} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[14px]">删除 OSS 仓文件</DialogTitle>
          </DialogHeader>
          {confirmDel && (
            <div className="space-y-2 text-[12.5px] text-foreground/75">
              {confirmDel.nOrphan > 0 && (
                <p>· <b>{confirmDel.nOrphan}</b> 个未纳管文件将从 OSS 仓<b>永久删除</b></p>
              )}
              {confirmDel.nLocal > 0 && (
                <p className="text-rose-600 dark:text-rose-400">
                  · <b>{confirmDel.nLocal}</b> 个已入库对象将<b>连同图库记录一起删除</b>(本机 + 云端 + 文件与缩略图),标签等信息不可恢复
                </p>
              )}
              {confirmDel.nCloud > 0 && (
                <p className="text-foreground/45">· {confirmDel.nCloud} 个云端已发布对象将被跳过(由发布它的电脑管理)</p>
              )}
              <p className="text-[11.5px] text-foreground/45 pt-1">文件删除不可撤销,请确认。</p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button onClick={() => setConfirmDel(null)}>取消</Button>
            <button
              onClick={() => confirmDel && deleteObjects.mutate(confirmDel.keys)}
              disabled={deleteObjects.isPending}
              className="inline-flex items-center justify-center gap-1 px-3 py-1.5 text-[12px] rounded-md bg-rose-600 text-white hover:bg-rose-700 transition-colors disabled:opacity-50">
              {deleteObjects.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              确认删除
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── 云端已发布图详情 — 标签等信息直接展示远端数据,不需要拉到本地 ──────
function CloudImageInspector({ item }: { item: OssObjectItem }) {
  const detail = useQuery({
    queryKey: ['oss-cloud-image', item.image_id],
    queryFn: () => api.ossLibrary.cloudImage(item.image_id!),
    enabled: !!item.image_id,
    staleTime: 60_000,
  })
  const d = detail.data
  const name = d?.file_name || item.cloud_file_name || item.object_key.split('/').pop() || ''

  // 标签按维度分组展示
  const tagGroups = useMemo(() => {
    const g: Record<string, string[]> = {}
    for (const t of d?.tags ?? []) {
      (g[t.dimension] ||= []).push(t.value)
    }
    return Object.entries(g)
  }, [d])

  return (
    <aside className="w-[280px] shrink-0 border-l border-foreground/5 overflow-y-auto">
      <div className="p-3.5 space-y-3.5">
        <div className="rounded-md overflow-hidden bg-foreground/[0.04]">
          {item.preview_url && <img src={item.preview_url} alt={name} className="w-full aspect-[4/3] object-cover" />}
        </div>
        <div>
          <h3 className="text-[13px] font-medium text-foreground/85 break-all leading-tight">{name}</h3>
          <p className="text-[11px] text-sky-600 dark:text-sky-400 mt-1 flex items-center gap-1">
            <Cloud size={11} /> 云端已发布(其他电脑维护)
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          <Tag tone={d?.review_status === 'approved' || item.review_status === 'approved' ? 'ok' : 'muted'}>
            {(d?.review_status || item.review_status) === 'approved' ? '已审核' : '待审核'}
          </Tag>
          <Tag tone={(d?.is_listed ?? item.is_listed) ? 'accent' : 'muted'}>
            {(d?.is_listed ?? item.is_listed) ? '已上架' : '未上架'}
          </Tag>
          {d?.width && d?.height && <Tag tone="muted">{d.width}×{d.height}</Tag>}
        </div>

        {detail.isLoading ? (
          <div className="space-y-1.5">
            {[1, 2, 3].map((i) => <div key={i} className="h-5 rounded bg-foreground/[0.04] animate-pulse" />)}
          </div>
        ) : detail.isError ? (
          <p className="text-[11px] text-foreground/40">远端信息获取失败(检查网络后重试)</p>
        ) : <>
          {d?.description && (
            <p className="text-[11.5px] text-foreground/65 leading-relaxed">{d.description}</p>
          )}
          {tagGroups.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[11px] font-medium text-foreground/50">标签({d?.tags.length}）</h4>
              {tagGroups.map(([dim, values]) => (
                <div key={dim} className="flex flex-wrap gap-1">
                  {values.map((v) => (
                    <span key={v} className="text-[10.5px] px-1.5 py-0.5 rounded bg-foreground/[0.05] text-foreground/70">
                      {v}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>}

        <div className="text-[11px] text-foreground/45 leading-relaxed border-t border-foreground/5 pt-2.5">
          这张图的信息由其他电脑维护,以上为远端实时数据。
          要在本机参与匹配/编辑,打开 设置 → 通用 → <b>多设备同步</b> 即自动同步到本机。
        </div>
        <p className="text-[10px] text-foreground/35 break-all leading-snug">对象 key：{item.object_key}</p>
      </div>
    </aside>
  )
}

// ── 网格单元 ─────────────────────────────────────────────────────────────
function OssCell({
  item, height, selected, active, onToggleSelect, onClick, onListing, onImport, onDelete, busy,
}: {
  item: OssObjectItem; height: number; selected: boolean; active: boolean
  onToggleSelect: () => void; onClick: () => void
  onListing: (listed: boolean) => void; onImport: () => void; onDelete: () => void; busy: boolean
}) {
  return (
    <div
      className={cn('relative group rounded-md overflow-hidden border bg-foreground/[0.03] cursor-pointer',
        active ? 'border-accent ring-1 ring-accent' : 'border-foreground/8 hover:border-foreground/20')}
      style={{ aspectRatio: '1' }}
      onClick={onClick}
    >
      {item.preview_url && (
        <img src={item.preview_url} alt={item.object_key} loading="lazy" className="w-full h-full object-cover" />
      )}
      {/* 选择框 */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleSelect() }}
        className={cn('absolute top-1.5 left-1.5 w-4 h-4 rounded-sm border flex items-center justify-center transition-all',
          selected ? 'bg-accent border-accent text-white' : 'border-white/70 bg-black/20 opacity-0 group-hover:opacity-100')}>
        {selected && <Check size={10} strokeWidth={3} />}
      </button>
      {/* 状态角标:未纳管(橙) / 云端已发布(蓝+审核态) / 本机(审核+上架) */}
      <div className="absolute top-1.5 right-1.5 flex flex-col gap-0.5 items-end">
        {item.status === 'orphan' ? (
          <Tag tone="warn">未纳管</Tag>
        ) : item.status === 'cloud' ? <>
          <Tag tone="info">云端</Tag>
          {typeof item.cloud_tag_count === 'number' && item.cloud_tag_count > 0 && (
            <Tag tone="muted">{item.cloud_tag_count} 标签</Tag>
          )}
          <Tag tone={item.is_listed ? 'accent' : 'muted'}>{item.is_listed ? '已上架' : '未上架'}</Tag>
        </> : <>
          <Tag tone={item.review_status === 'approved' ? 'ok' : item.review_status === 'rejected' ? 'bad' : 'muted'}>
            {item.review_status === 'approved' ? '已审' : item.review_status === 'rejected' ? '拒' : '待审'}
          </Tag>
          <Tag tone={item.is_listed ? 'accent' : 'muted'}>{item.is_listed ? '已上架' : '未上架'}</Tag>
        </>}
      </div>
      {/* hover 动作:未纳管→导入+删;本机→上下架+删;云端→无(去详情看远端信息) */}
      <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        {item.status === 'orphan' ? (
          <ActionBtn onClick={onImport} disabled={busy}><CloudDownload size={10} /> 导入</ActionBtn>
        ) : item.status === 'local' ? (
          <ActionBtn onClick={() => onListing(!item.is_listed)} disabled={busy}>
            {item.is_listed ? <><EyeOff size={10} /> 下架</> : <><Eye size={10} /> 上架</>}
          </ActionBtn>
        ) : null}
        {item.status !== 'cloud' && (
          <ActionBtn onClick={onDelete} disabled={busy}><Trash2 size={10} /></ActionBtn>
        )}
      </div>
    </div>
  )
}

function OssOrphanInspector({ item, projectId, onImport, onDelete, importing }: {
  item: OssObjectItem | null; projectId: string | null
  onImport: () => void; onDelete: () => void; importing: boolean
}) {
  if (!item) {
    return (
      <aside className="w-[280px] shrink-0 border-l border-foreground/5 flex items-center justify-center text-[12px] text-foreground/35 px-6 text-center">
        选中一张图片查看详情
      </aside>
    )
  }
  const name = item.object_key.split('/').pop() || item.object_key
  return (
    <aside className="w-[280px] shrink-0 border-l border-foreground/5 overflow-y-auto">
      <div className="p-3.5 space-y-3.5">
        <div className="rounded-md overflow-hidden bg-foreground/[0.04]">
          {item.preview_url && <img src={item.preview_url} alt={name} className="w-full aspect-[4/3] object-cover" />}
        </div>
        <div>
          <h3 className="text-[13px] font-medium text-foreground/85 break-all leading-tight">{name}</h3>
          <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">未纳管（任何电脑都没导入过）</p>
        </div>
        {item.status === 'orphan' && (
          <Button block onClick={onImport} disabled={!projectId || importing}>
            {importing ? <Loader2 size={12} className="animate-spin mr-1.5" /> : <CloudDownload size={12} className="mr-1.5" />}
            导入到灵图库（待审核）
          </Button>
        )}
        {item.status === 'orphan' && (
          <button
            onClick={onDelete}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md border border-rose-500/25 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition-colors">
            <Trash2 size={12} /> 从 OSS 仓删除此文件
          </button>
        )}
        <div className="text-[11px] text-foreground/45 leading-relaxed">
          导入后默认「待审核 + 未上架」，自动派发向量与打标；到「审核」通过并上架后才进入 UGC 匹配候选池。
        </div>
        <div className="pt-2 border-t border-foreground/5">
          <p className="text-[10px] text-foreground/35 break-all leading-snug">对象 key：{item.object_key}</p>
        </div>
      </div>
    </aside>
  )
}

// ── 小组件 ───────────────────────────────────────────────────────────────
function Button({ children, onClick, disabled, block, title }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; block?: boolean; title?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={cn('inline-flex items-center justify-center px-2.5 py-1 text-[12px] rounded-md border border-foreground/12 bg-foreground/[0.02] text-foreground/75 hover:bg-foreground/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        block && 'w-full')}>
      {children}
    </button>
  )
}

function ActionBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="bg-background/90 backdrop-blur rounded px-1.5 py-0.5 text-[10px] flex items-center gap-0.5 shadow border border-foreground/10 hover:bg-background disabled:opacity-50">
      {children}
    </button>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'bad' | 'warn' | 'accent' | 'info' | 'muted' }) {
  const map: Record<string, string> = {
    ok: 'bg-emerald-500/85', bad: 'bg-rose-500/85', warn: 'bg-amber-500/90',
    accent: 'bg-accent/85', info: 'bg-sky-500/85', muted: 'bg-foreground/55',
  }
  return <span className={cn('text-[9px] px-1 rounded text-white', map[tone])}>{children}</span>
}

function LoadMore({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) onVisible() }, { rootMargin: '300px' })
    obs.observe(el); return () => obs.disconnect()
  }, [onVisible])
  return <div ref={ref} className="h-4" />
}
