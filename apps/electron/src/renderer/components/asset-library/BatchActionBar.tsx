import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  CheckCircle, ChevronDown, Cloud, Copy, Download, Loader2, RotateCw, Rocket,
  ShieldCheck, Tag as TagIcon, Trash2, Wand2, X, XCircle,
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
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: () => toast.error('删除失败'),
  })

  // ── Re-run pipeline engines on selected images ──
  // All four engines now accept an `image_ids` param that scopes processing
  // to the selection AND forces reprocessing (clears prior status/tags/groups).
  const reprocessMutation = useMutation({
    mutationFn: async ({ type, label, extra = {} }: {
      type: 'quality_check' | 'orient' | 'dedup' | 'tag'
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
        </DropdownMenuContent>
      </DropdownMenu>

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
