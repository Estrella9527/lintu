import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  CheckCircle, ChevronDown, Cloud, Copy, Download, Image as ImageIcon,
  Loader2, RotateCw, Rocket, ShieldCheck, Tag as TagIcon, Trash2, Wand2, X, XCircle,
} from 'lucide-react'
import { activeModuleAtom } from '@/atoms/navigation'
import { activeProjectIdAtom } from '@/atoms/project'
import { batchSeedQueueAtom } from '@/atoms/workshop'
import { assetLibraryFilterAtom } from '@/atoms/ui-state'
import { api, apiFetchRaw } from '@/lib/api'
import type { ImageRecord } from '@/lib/types'

interface BatchActionBarProps {
  selectedCount: number
  selectedIds: Set<string>
  onClear: () => void
  /** 'library' = 全部图片 (default, full toolbar);
   *  'trash'   = 回收站 (restore / download / delete only) */
  mode?: 'library' | 'trash'
}

export function BatchActionBar({ selectedCount, selectedIds, onClear, mode = 'library' }: BatchActionBarProps) {
  const queryClient = useQueryClient()
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setSeedQueue = useSetAtom(batchSeedQueueAtom)
  const projectId = useAtomValue(activeProjectIdAtom)
  // Read the asset library's filter so we can derive a human-readable
  // label for the task ("Prompt-X 选区" instead of just "AI打标"). Lets
  // the user disambiguate concurrent per-prompt tag tasks in TaskCenter.
  const filter = useAtomValue(assetLibraryFilterAtom)
  const ids = Array.from(selectedIds)

  const buildTaskLabel = (action: string) => {
    const bits: string[] = []
    if (filter.prompt_id && filter.prompt_label) bits.push(`Prompt: ${filter.prompt_label}`)
    if (filter.parent_id && filter.parent_label) bits.push(`衍生自: ${filter.parent_label}`)
    if (filter.source && filter.source !== 'all') {
      bits.push(filter.source === 'generated' ? '生成图' : filter.source === 'original' ? '原图' : filter.source)
    }
    if (filter.status && filter.status !== 'all') bits.push(`状态: ${filter.status}`)
    bits.push(`${ids.length} 张`)
    return `${action} · ${bits.join(' · ')}`
  }

  const sendToWorkshop = async () => {
    if (ids.length === 0) return
    try {
      // Fetch full ImageRecord for each — needed because the parent only
      // knows the ids, but BatchRunDialog wants {id, file_name, ...}
      const records: ImageRecord[] = await Promise.all(
        ids.map((id) =>
          apiFetchRaw(`/images/${id}`).then((r) => r.json())
        )
      )
      setSeedQueue(records)
      setActiveModule('ai-workshop')
      onClear()
      toast.success(`已带 ${records.length} 张到 AI 工坊，正在打开批量生产对话框…`)
    } catch (e: any) {
      toast.error(`加载图片失败：${e?.message || e}`)
    }
  }

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetchRaw('/images/batch/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids }),
      }).then((r) => r.json()),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 张图片`)
      onClear()
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['image-folders'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: () => toast.error('删除失败'),
  })

  // ── Re-run pipeline engines on selected images ──
  // All four engines now accept an `image_ids` param that scopes processing
  // to the selection AND forces reprocessing (clears prior status/tags/groups).
  const reprocessMutation = useMutation({
    mutationFn: async ({ type, label, extra = {} }: {
      type: 'quality_check' | 'orient' | 'dedup' | 'tag' | 'compress'
      label: string
      extra?: Record<string, unknown>
    }) => {
      if (!projectId) throw new Error('请先选择项目')
      if (ids.length === 0) throw new Error('未选择图片')
      // Dedup is comparison-based: it only finds duplicates among the SELECTED
      // set. Warn the user if the selection is small relative to a typical
      // duplicate window (the user might think dedup looks across the whole
      // library when given a subset).
      if (type === 'dedup' && ids.length < 200) {
        const ok = window.confirm(
          `去重只在选中的 ${ids.length} 张图片之间查找重复，` +
          `不会跨选区比对。\n\n要在整个项目中去重，请到「流水线 → 去重」。\n\n继续？`
        )
        if (!ok) throw new Error('已取消')
      }
      const result = await api.tasks.create(type, {
        project_id: projectId,
        image_ids: ids,
        label: buildTaskLabel(label),
        ...extra,
      })
      return { ...result, label }
    },
    onSuccess: ({ label }) => {
      toast.success(`已对 ${ids.length} 张图片提交「${label}」任务，可在任务中心查看进度`)
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['image-folders'] })
      onClear()
    },
    onError: (e: Error) => toast.error(`提交失败：${e.message}`),
  })

  // ── Push selected images to OSS ──
  // Sends just this filtered selection to oss_sync_jobs queue. Does NOT block;
  // the worker drains the queue in background. Caller can re-sync (force=true)
  // to overwrite an existing CDN copy (rare).
  const ossSyncMutation = useMutation({
    mutationFn: async ({ force }: { force: boolean }) => {
      if (ids.length === 0) throw new Error('未选择图片')
      const r = await apiFetchRaw('/oss/enqueue-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids, force }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error((err as any)?.error?.message || (err as any)?.detail || `HTTP ${r.status}`)
      }
      return r.json() as Promise<{ images: number; jobs_added: number }>
    },
    onSuccess: ({ images, jobs_added }) => {
      toast.success(`已入队 ${images} 张图片（共 ${jobs_added} 个上传任务），后台同步中`, {
        description: '进度可在「分发中心 → OSS 同步」查看',
      })
      onClear()
      queryClient.invalidateQueries({ queryKey: ['oss-status'] })
    },
    onError: (e: Error) => toast.error(`OSS 同步失败：${e.message}`),
  })

  // 选区软重置:把这批图的 cdn_path 清空 + 删它们对应的 jobs。
  // 不动 OSS 上对象,适合"想让这部分图重走一次同步"。配合上面的"强制重新
  // 同步 OSS"是替代品:force=true 直接覆盖,软重置则是先 reset 再让你自己
  // 决定何时回填。
  const ossResetMutation = useMutation({
    mutationFn: async () => {
      if (ids.length === 0) throw new Error('未选择图片')
      const d = new Date()
      const utc = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
      const r = await apiFetchRaw('/oss/reset-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: `RESET-${utc}`, image_ids: ids }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error((err as any)?.error?.message || (err as any)?.detail || `HTTP ${r.status}`)
      }
      return r.json() as Promise<{ images_reset: number; jobs_deleted: number }>
    },
    onSuccess: ({ images_reset, jobs_deleted }) => {
      toast.success(`已重置 ${images_reset} 张图的 cdn_path + 删 ${jobs_deleted} 个任务（OSS 对象保留）`)
      onClear()
      queryClient.invalidateQueries({ queryKey: ['oss-status'] })
    },
    onError: (e: Error) => toast.error(`软重置失败：${e.message}`),
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      apiFetchRaw(`/images/batch/update-status?status=${status}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('状态已更新')
      onClear()
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['image-folders'] })
    },
  })

  const handleDownload = async () => {
    if (ids.length === 1) {
      // Single file: show save dialog so user can pick name + location
      const id = ids[0]
      const detailRes = await apiFetchRaw(`/images/${id}`)
      const detail = await detailRes.json()
      const url = api.images.downloadUrl(id)
      const saved = await window.electronAPI.downloadFile(url, detail.file_name || `${id}.jpg`)
      if (saved) toast.success(`已保存到 ${saved}`)
      return
    }

    // Multi-file: pick the destination directory ONCE, then write every file
    // straight to disk via saveFileToPath (no per-file native save dialog).
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return

    const total = ids.length
    const toastId = toast.loading(`下载中 0/${total}…`)
    let saved = 0
    let failed = 0

    // Light parallelism — 6 concurrent fetches keeps a 12000-image batch
    // moving without saturating the sidecar or the local disk.
    const CONCURRENCY = 6
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (cursor < ids.length) {
        const i = cursor++
        const id = ids[i]
        try {
          const detailRes = await apiFetchRaw(`/images/${id}`)
          const detail = await detailRes.json()
          const filename = detail.file_name || `${id}.jpg`
          const url = api.images.downloadUrl(id)
          const result = await window.electronAPI.saveFileToPath(url, `${dir}/${filename}`)
          if (result) saved++
          else failed++
        } catch {
          failed++
        }
        toast.loading(`下载中 ${saved + failed}/${total}…`, { id: toastId })
      }
    })
    await Promise.all(workers)

    if (failed === 0) {
      toast.success(`已保存 ${saved} 张图片到 ${dir}`, { id: toastId })
    } else {
      toast.warning(`已保存 ${saved} 张，${failed} 张失败 → ${dir}`, { id: toastId })
    }
  }

  if (selectedCount === 0) return null

  // ── Trash mode: minimal toolbar (recover / download / permanent delete) ──
  if (mode === 'trash') {
    return (
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 mb-2 rounded-lg bg-destructive/5 border border-destructive/20">
        <span className="text-[12.5px] text-destructive font-medium whitespace-nowrap shrink-0 mr-1">
          已选 {selectedCount.toLocaleString()} 张（回收站）
        </span>

        <Button
          size="sm"
          className="h-7 text-[12px] whitespace-nowrap shrink-0"
          onClick={() => statusMutation.mutate('passed')}
          disabled={statusMutation.isPending}
        >
          <CheckCircle size={12} className="mr-1" /> 恢复（还原为通过）
        </Button>

        <Button variant="outline" size="sm" className="h-7 text-[12px] whitespace-nowrap shrink-0" onClick={handleDownload}>
          <Download size={12} className="mr-1" /> 下载
        </Button>

        <Button
          variant="outline" size="sm"
          className="h-7 text-[12px] text-destructive border-destructive/40 hover:bg-destructive/10 whitespace-nowrap shrink-0"
          onClick={() => {
            if (deleteMutation.isPending) return
            if (confirm(`永久删除 ${selectedCount.toLocaleString()} 张图片？\n\n文件和数据库记录都会被清除，此操作不可撤销。`)) {
              deleteMutation.mutate()
            }
          }}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending ? (
            <>
              <Loader2 size={12} className="mr-1 animate-spin" />
              删除中… ({selectedCount.toLocaleString()})
            </>
          ) : (
            <>
              <Trash2 size={12} className="mr-1" /> 永久删除
            </>
          )}
        </Button>

        <div className="flex-1" />

        <Button variant="ghost" size="sm" className="h-7 text-[12px] text-foreground/40 whitespace-nowrap shrink-0" onClick={onClear}>
          <X size={12} className="mr-1" /> 取消选择
        </Button>
      </div>
    )
  }

  // ── Library mode: full toolbar ──
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 mb-2 rounded-lg bg-accent/5 border border-accent/20">
      <span className="text-[12.5px] text-accent font-medium whitespace-nowrap shrink-0 mr-1">
        已选 {selectedCount.toLocaleString()} 张
      </span>

      <Button
        size="sm"
        className="h-7 text-[12px] whitespace-nowrap shrink-0"
        onClick={sendToWorkshop}
      >
        <Rocket size={12} className="mr-1" /> 进入 AI 工坊
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-[12px]" disabled={reprocessMutation.isPending}>
            <Wand2 size={12} className="mr-1" /> 重新处理
            <ChevronDown size={11} className="ml-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuLabel className="text-[10.5px] text-foreground/40">
            对选中 {selectedCount} 张图片执行
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => reprocessMutation.mutate({ type: 'quality_check', label: '质量检查' })}
            className="text-[12.5px] gap-2"
          >
            <ShieldCheck size={13} className="text-foreground/55" />
            质量检查
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => reprocessMutation.mutate({ type: 'orient', label: '视角矫正', extra: { mode: 'auto+ai' } })}
            className="text-[12.5px] gap-2"
          >
            <RotateCw size={13} className="text-foreground/55" />
            视角矫正（AI 辅助）
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => reprocessMutation.mutate({ type: 'dedup', label: '去重', extra: { mode: 'balanced' } })}
            className="text-[12.5px] gap-2"
          >
            <Copy size={13} className="text-foreground/55" />
            去重（平衡模式）
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => reprocessMutation.mutate({ type: 'tag', label: '打标' })}
            className="text-[12.5px] gap-2"
          >
            <TagIcon size={13} className="text-foreground/55" />
            <div className="flex-1">
              <div>打标（按筛选/选择批量）</div>
              <div className="text-[10px] text-foreground/40">用 12 维 schema 重新分类，清除旧 AI 标签</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (confirm(
                `批量压缩 ${selectedCount} 张图片(强力档)?\n\n` +
                `· 格式: JPEG q=80 progressive + 4:2:0 子采样\n` +
                `· 尺寸: 最长边 ≤ 2400px(超过等比缩;覆盖手机全屏 + 4K 显示绰绰有余)\n` +
                `· 典型 2-3M → 0.4-0.8M(节省 70-85%)\n` +
                `· 原图自动备份为 <文件名>.orig(可手动 rm 释放空间)\n` +
                `· 压缩后自动覆盖上传到 OSS\n\n` +
                `不可逆操作 — 只要 .orig 还在就能恢复。继续?`
              )) {
                reprocessMutation.mutate({
                  type: 'compress',
                  label: 'JPEG q80 + 2400px',
                  extra: { quality: 80, max_long_side: 2400, force: false },
                })
              }
            }}
            disabled={reprocessMutation.isPending}
            className="text-[12.5px] gap-2"
          >
            <ImageIcon size={13} className="text-foreground/55" />
            <div className="flex-1">
              <div>批量压缩(强力 · JPEG q80 + 2400px)</div>
              <div className="text-[10px] text-foreground/40">2-3M → 0.4-0.8M · 原地覆盖 + .orig 备份 · 自动重传 OSS</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => ossSyncMutation.mutate({ force: false })}
            disabled={ossSyncMutation.isPending}
            className="text-[12.5px] gap-2"
          >
            <Cloud size={13} className="text-foreground/55" />
            <div className="flex-1">
              <div>同步到 OSS</div>
              <div className="text-[10px] text-foreground/40">仅入队未同步过的图片</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (confirm(`强制重新同步 ${selectedCount} 张图片到 OSS？\n会覆盖现有 CDN 副本。`)) {
                ossSyncMutation.mutate({ force: true })
              }
            }}
            disabled={ossSyncMutation.isPending}
            className="text-[12.5px] gap-2"
          >
            <Cloud size={13} className="text-warning" />
            <div className="flex-1">
              <div className="text-warning">强制重新同步 OSS</div>
              <div className="text-[10px] text-foreground/40">覆盖已同步的 CDN 副本</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (confirm(`软重置 ${selectedCount} 张图的 OSS 同步状态？\n\n• 清空这些图的 cdn_path（数据库标记为"未同步"）\n• 删除它们的同步任务\n• OSS 上的对象保留，后续重传同 key 会自动覆盖\n\n场景:你先用「强制重新同步」重传了一部分图，再对剩下的图用这个软重置，让它们回到"未同步"状态以便有序回填。`)) {
                ossResetMutation.mutate()
              }
            }}
            disabled={ossResetMutation.isPending}
            className="text-[12.5px] gap-2"
          >
            <Cloud size={13} className="text-foreground/40" />
            <div className="flex-1">
              <div>软重置选中图的 OSS 状态</div>
              <div className="text-[10px] text-foreground/40">清 cdn_path + 删任务,OSS 对象不动</div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BatchTagButton ids={ids} onDone={onClear} />

      <Button variant="outline" size="sm" className="h-7 text-[12px] whitespace-nowrap shrink-0" onClick={handleDownload}>
        <Download size={12} className="mr-1" /> 下载
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => statusMutation.mutate('passed')}>
        <CheckCircle size={12} className="mr-1" /> 标记通过
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => statusMutation.mutate('rejected')}>
        <XCircle size={12} className="mr-1" /> 标记淘汰
      </Button>

      <Button
        variant="outline" size="sm"
        className="h-7 text-[12px] text-destructive border-destructive/30 hover:bg-destructive/10"
        onClick={() => {
          if (deleteMutation.isPending) return
          if (confirm(`确定删除 ${selectedCount} 张图片？此操作不可撤销。`)) deleteMutation.mutate()
        }}
        disabled={deleteMutation.isPending}
      >
        {deleteMutation.isPending ? (
          <>
            <Loader2 size={12} className="mr-1 animate-spin" /> 删除中…
          </>
        ) : (
          <>
            <Trash2 size={12} className="mr-1" /> 删除
          </>
        )}
      </Button>

      <div className="flex-1" />

      <Button variant="ghost" size="sm" className="h-7 text-[12px] text-foreground/40" onClick={onClear}>
        <X size={12} className="mr-1" /> 取消选择
      </Button>
    </div>
  )
}

type DimSchema = { label?: string; multi?: boolean; values?: string[] }

/** 批量人工打标:收集 维度→取值(受控,仅标签体系内),一次性应用到选中图。 */
function BatchTagButton({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const { data: schema } = useQuery<Record<string, DimSchema>>({
    queryKey: ['tag-schema'],
    queryFn: () => apiFetchRaw('/tag-schema').then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })
  const apply = useMutation({
    mutationFn: () => api.images.batchTag(ids, picked, 'add'),
    onSuccess: (d) => {
      toast.success(`已给 ${d.updated} 张图打标`)
      setPicked({})
      onDone()
      qc.invalidateQueries({ queryKey: ['images'] })
      qc.invalidateQueries({ queryKey: ['image-folders'] })
    },
    onError: (e: any) => toast.error(e?.message || '批量打标失败'),
  })
  const toggle = (dim: string, v: string) =>
    setPicked((p) => {
      const cur = p[dim] || []
      return { ...p, [dim]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }
    })
  const count = Object.values(picked).reduce((n, a) => n + a.length, 0)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[12px] whitespace-nowrap shrink-0">
          <TagIcon size={12} className="mr-1" /> 批量打标
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] max-h-[460px] p-0 overflow-hidden flex flex-col" align="start">
        <div className="px-3 py-2 border-b border-foreground/8 text-[11px] font-medium text-foreground/70">
          给选中 {ids.length} 张打人工标签 <span className="text-foreground/40 font-normal">· 仅标签体系内取值</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2.5">
          {schema && Object.entries(schema).map(([dim, ds]) => (
            <div key={dim}>
              <div className="text-[10px] text-foreground/45 mb-1">{ds.label || dim}{ds.multi ? '' : ' · 单选'}</div>
              <div className="flex flex-wrap gap-1">
                {(ds.values || []).map((v) => {
                  const on = (picked[dim] || []).includes(v)
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => toggle(dim, v)}
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] border',
                        on ? 'bg-accent/15 text-accent border-accent/40'
                          : 'border-foreground/10 hover:border-accent/30 hover:text-accent',
                      )}
                    >
                      {v}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 py-2 border-t border-foreground/8 flex items-center justify-between">
          <span className="text-[10px] text-foreground/45">已选 {count} 个标签值</span>
          <Button size="sm" className="h-7 text-[11px]" disabled={count === 0 || apply.isPending}
            onClick={() => apply.mutate()}>
            应用到 {ids.length} 张
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
