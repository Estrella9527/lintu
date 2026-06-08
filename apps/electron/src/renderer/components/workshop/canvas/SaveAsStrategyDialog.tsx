import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Save } from 'lucide-react'

import { useSetAtom } from 'jotai'
import { apiFetchRaw } from '@/lib/api'
import { autoSelectStrategyAtom, workshopBatchDialogAtom, workshopModeAtom } from '@/atoms/workshop'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

interface SaveAsStrategyDialogProps {
  open: boolean
  onClose: () => void
  /** 当前画布的参数快照(model / ratios / style / speed / count 等) */
  canvasSnapshot: Record<string, unknown>
  /** 默认 task_type — 用 canvas snapshot 里推断的 type,如果有的话 */
  defaultTaskType?: string
  onSaved?: (strategy: { id: string; name: string }) => void
}

/**
 * 把当前画布参数固化为一条策略 — PRD §5「双模式桥接」核心动作之一。
 *
 * 提交字段(/strategies POST):
 *   - name / task_type / prompt / parameters(JSON)— 现有字段保留
 *   - **provenance='from_canvas'** + **canvas_snapshot={当前所有参数}**
 *     这两个字段让策略库能挑出"来自画布"的策略加📐标识
 *
 * Phase 1 简化:不在这里二次编辑参数,所见即所存;改参数让用户回画布再做。
 */
export function SaveAsStrategyDialog({
  open, onClose, canvasSnapshot, defaultTaskType, onSaved,
}: SaveAsStrategyDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const queryClient = useQueryClient()
  const setAutoSelect = useSetAtom(autoSelectStrategyAtom)
  const setMode = useSetAtom(workshopModeAtom)
  const setShowBatch = useSetAtom(workshopBatchDialogAtom)

  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
    }
  }, [open])

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        icon_keyword: '',
        prompt: description.trim(),
        task_type: defaultTaskType || 'custom',
        parameters: '[]',
        sort_order: 99,
        provenance: 'from_canvas',
        canvas_snapshot: canvasSnapshot,
      }
      const res = await apiFetchRaw('/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
      }
      return res.json() as Promise<{ id: string; name: string }>
    },
    onSuccess: (data) => {
      // v0.3 PR-12 一键转批量真打通:写 autoSelectStrategyAtom + 切 batch mode,
      // BatchMode 监听后自动选中这条策略 + 关 batch dialog(避免又弹一层弹窗)。
      setAutoSelect(data.id)
      setShowBatch(false)
      setMode('batch')
      toast.success(`已保存策略「${data.name}」 · 已转到批量策略 mode`)
      queryClient.invalidateQueries({ queryKey: ['strategies'] })
      onSaved?.(data)
      onClose()
    },
    onError: (e: Error) => {
      toast.error(`保存失败:${e.message}`)
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">存为策略</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <label className="text-[11.5px] text-foreground/55">策略名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如:晨曦丁达尔 · 漂流主图"
              maxLength={64}
              className="h-8 text-[12.5px]"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11.5px] text-foreground/55">描述(可选)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话描述这条策略的用法,会作为默认 prompt 提示"
              className="min-h-[60px] text-[12.5px] resize-none"
            />
          </div>

          <div className="rounded-md border border-foreground/8 bg-foreground/[0.02] p-2.5 text-[11px] text-foreground/55 leading-relaxed">
            <div className="text-foreground/75 mb-1">本次会固化的参数</div>
            <ul className="space-y-0.5 tabular-nums">
              {Object.entries(canvasSnapshot).slice(0, 6).map(([k, v]) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-foreground/45">{k}</span>
                  <span className="text-foreground/70 truncate max-w-[200px]">
                    {typeof v === 'string' || typeof v === 'number' ? String(v) : JSON.stringify(v).slice(0, 30)}
                  </span>
                </li>
              ))}
              {Object.keys(canvasSnapshot).length > 6 && (
                <li className="text-foreground/40">+ {Object.keys(canvasSnapshot).length - 6} 个其它参数…</li>
              )}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saveMutation.isPending}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending
              ? <><Loader2 size={12} className="mr-1.5 animate-spin" /> 保存中</>
              : <><Save size={12} className="mr-1.5" /> 保存策略</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
