import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Loader2, Palette, Plus, Save, Trash2 } from 'lucide-react'

import { apiFetchRaw } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { ThumbnailImage } from '@/components/asset-library/ThumbnailImage'
import { SeedPickerDialog } from '@/components/workshop/SeedPickerDialog'
import type { StyleArchive } from '@/components/workshop/StyleArchivePicker'
import type { ImageRecord } from '@/lib/types'

/**
 * 设置 → 风格档案 Tab(v0.3 新)
 *
 * 列表 + 新建 / 编辑 / 删除。每个档案 = 一组参考图 + 一致性强度。
 * 画布生成 / 批量配置都能挑一个 StyleArchive 来保证跨图风格统一。
 *
 * Phase 1 简化:
 *   - 不做"档案下挂多少图被引用"的统计 (Phase 2)
 *   - params(provider 特定 JSON) 不在 UI 暴露,先存空 dict
 */
export function StyleArchiveTab() {
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading } = useQuery<{ items: StyleArchive[] }>({
    queryKey: ['style-archives', projectId],
    queryFn: () => apiFetchRaw(`/style-archives?project_id=${projectId}`).then((r) => r.json()),
    enabled: !!projectId,
  })
  const items = data?.items || []

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetchRaw(`/style-archives/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('已删除风格档案')
      queryClient.invalidateQueries({ queryKey: ['style-archives', projectId] })
    },
  })

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-medium text-foreground/85 inline-flex items-center gap-1.5">
            <Palette size={14} className="text-accent" /> 风格档案
          </h2>
          <p className="text-[11.5px] text-foreground/55 mt-1 max-w-md">
            把一组参考图固化为「风格档案」,在画布 / 批量生产时一键应用,跨图保持视觉一致。
          </p>
        </div>
        <Button size="sm" className="h-8 text-[12px]" disabled={!projectId} onClick={() => setShowCreate(true)}>
          <Plus size={12} className="mr-1.5" /> 新建档案
        </Button>
      </div>

      {!projectId ? (
        <div className="rounded-lg border border-foreground/8 bg-foreground/[0.02] p-6 text-center text-[12px] text-foreground/45">
          请先选择项目
        </div>
      ) : isLoading ? (
        <div className="rounded-lg border border-foreground/8 bg-foreground/[0.02] p-6 text-center text-[12px] text-foreground/45">
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-foreground/12 p-10 text-center">
          <Palette size={24} strokeWidth={1.3} className="mx-auto text-foreground/30" />
          <div className="mt-2 text-[12.5px] text-foreground/55">还没有风格档案</div>
          <div className="text-[11px] text-foreground/40 mt-1">
            点上方「新建档案」开始 — 一个项目可以有多个不同风格(如「晨曦丁达尔」「秋日金黄」)
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id}
                 className="flex items-center gap-3 rounded-lg border border-foreground/8
                            bg-background hover:bg-foreground/[0.015] p-3 transition-colors">
              <div className="flex -space-x-1 shrink-0">
                {(it.ref_image_ids.slice(0, 3)).map((id) => (
                  <div key={id} className="h-10 w-10 rounded-md overflow-hidden ring-1 ring-foreground/8">
                    <ThumbnailImage imageId={id} size={128} className="w-full h-full object-cover" />
                  </div>
                ))}
                {it.ref_image_ids.length === 0 && (
                  <div className="h-10 w-10 rounded-md bg-foreground/[0.04] flex items-center justify-center">
                    <Palette size={14} className="text-foreground/35" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-foreground/85 truncate">{it.name}</div>
                <div className="text-[11px] text-foreground/50 truncate">
                  {it.description || `${it.ref_image_ids.length} 张参考图 · 强度 ${it.strength_default}`}
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-[11.5px]"
                      onClick={() => setEditingId(it.id)}>
                编辑
              </Button>
              <Button variant="ghost" size="sm"
                      className="h-7 text-[11.5px] text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        if (confirm(`删除风格档案「${it.name}」?\n引用它的策略会变成无样式。`)) {
                          deleteMutation.mutate(it.id)
                        }
                      }}>
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
        </div>
      )}

      <StyleArchiveDialog
        open={showCreate || !!editingId}
        onClose={() => { setShowCreate(false); setEditingId(null) }}
        archive={editingId ? items.find((it) => it.id === editingId) || null : null}
      />
    </div>
  )
}

interface StyleArchiveDialogProps {
  open: boolean
  onClose: () => void
  archive: StyleArchive | null
}

function StyleArchiveDialog({ open, onClose, archive }: StyleArchiveDialogProps) {
  const isEdit = !!archive
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()
  const [name, setName] = useState(archive?.name || '')
  const [description, setDescription] = useState(archive?.description || '')
  const [strength, setStrength] = useState(archive?.strength_default ?? 0.7)
  const [refIds, setRefIds] = useState<string[]>(archive?.ref_image_ids || [])
  const [showPicker, setShowPicker] = useState(false)

  // useState 初值只在组件首次 mount 时生效。Dialog 不卸载、只切 archive 时(列表里
  // 点另一个档案编辑),表单会停留在上一次的值 → 保存会用旧值覆盖新档案(数据破坏)。
  // 这里按 open + archive.id 变化重新灌入表单。
  useEffect(() => {
    if (!open) return
    setName(archive?.name || '')
    setDescription(archive?.description || '')
    setStrength(archive?.strength_default ?? 0.7)
    setRefIds(archive?.ref_image_ids || [])
    setShowPicker(false)
  }, [open, archive?.id])

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        project_id: projectId,
        name: name.trim(),
        description: description.trim(),
        ref_image_ids: refIds,
        strength_default: strength,
        params: {},
      }
      const url = isEdit ? `/style-archives/${archive!.id}` : '/style-archives'
      const res = await apiFetchRaw(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(t.slice(0, 200) || `HTTP ${res.status}`)
      }
      return res.json()
    },
    onSuccess: () => {
      toast.success(isEdit ? '已更新档案' : '已创建档案')
      queryClient.invalidateQueries({ queryKey: ['style-archives', projectId] })
      onClose()
    },
    onError: (e: Error) => toast.error(`保存失败:${e.message}`),
  })

  // 把 SeedPickerDialog 选中的 ImageRecord[] 映射为 ref_image_ids
  const onPickRefs = (imgs: ImageRecord[]) => {
    setRefIds(imgs.map((i) => i.id))
    setShowPicker(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[14px]">{isEdit ? '编辑风格档案' : '新建风格档案'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55">档案名称</label>
              <Input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="例如:晨曦丁达尔"
                className="h-8 text-[12.5px]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55">描述(可选)</label>
              <Textarea
                value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="一句话说明这种风格的主要特征"
                className="min-h-[60px] text-[12.5px] resize-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55 flex items-center justify-between">
                参考图({refIds.length})
                <Button variant="outline" size="sm" className="h-6 text-[11px]"
                        onClick={() => setShowPicker(true)}>
                  从资产库挑选
                </Button>
              </label>
              <div className="rounded-md border border-foreground/8 bg-foreground/[0.02] min-h-[60px] p-2 flex gap-1.5 flex-wrap">
                {refIds.length === 0 ? (
                  <div className="text-[11px] text-foreground/40 self-center mx-auto">尚未挑选</div>
                ) : refIds.slice(0, 12).map((id) => (
                  <div key={id} className="h-10 w-10 rounded-md overflow-hidden ring-1 ring-foreground/8">
                    <ThumbnailImage imageId={id} size={128} className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[11.5px] text-foreground/55 flex justify-between">
                <span>默认强度</span>
                <span className="tabular-nums text-foreground/75">{strength.toFixed(2)}</span>
              </label>
              <input type="range" min={0} max={1} step={0.05}
                     value={strength}
                     onChange={(e) => setStrength(Number(e.target.value))}
                     className="w-full accent-accent" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} disabled={saveMutation.isPending}>取消</Button>
            <Button size="sm" disabled={!name.trim() || saveMutation.isPending}
                    onClick={() => saveMutation.mutate()}>
              {saveMutation.isPending
                ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> 保存中</>
                : <><Save size={12} className="mr-1.5" /> {isEdit ? '更新' : '创建'}</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SeedPickerDialog
        open={showPicker}
        onClose={() => setShowPicker(false)}
        initialSelected={[]}
        onConfirm={onPickRefs}
        title="挑选参考图 — 风格档案"
        confirmLabel="作为参考图"
      />
    </>
  )
}
