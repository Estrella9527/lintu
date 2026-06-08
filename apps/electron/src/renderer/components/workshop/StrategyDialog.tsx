import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { apiFetchRaw } from '@/lib/api'
import { matchIcon } from '@/lib/icon-map'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { InfoHint } from '@/components/shared/InfoHint'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

/** Shape of a strategy row as returned by GET /api/strategies.
 *  v0.3 added provenance / canvas_snapshot / style_archive_id / speed /
 *  count_per_image. They're optional at the type level so old persisted rows
 *  still work; UI defaults provenance to 'manual' wherever needed.
 */
export interface StrategyRecord {
  id: string
  name: string
  icon_keyword: string
  task_type: string
  prompt: string
  parameters: string
  sort_order: number
  is_builtin: boolean
  enabled: boolean
  provenance?: 'manual' | 'from_canvas'
  canvas_snapshot?: Record<string, unknown> | null
  style_archive_id?: string | null
  speed?: 'draft' | 'refined'
  count_per_image?: number
}

const API = '/strategies'

interface StrategyDialogProps {
  open: boolean
  onClose: () => void
  strategy: StrategyRecord | null
  onSaved: () => void
}

/** 新建 / 编辑策略弹窗 — 从 v0.2 的 AIWorkshop.tsx 抽出来。
 *
 *  v0.3 改造把 AIWorkshop 改为 ModeTabs 容器后,这个对话框依然有用:
 *  「新建策略」入口在工坊顶部、「编辑策略」在批量 mode 的策略库右键菜单。
 */
export function StrategyDialog({ open, onClose, strategy, onSaved }: StrategyDialogProps) {
  const isEdit = !!strategy
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [iconKeyword, setIconKeyword] = useState('')
  const [prompt, setPrompt] = useState('')
  const [taskType, setTaskType] = useState('custom')
  const [paramsJson, setParamsJson] = useState('[]')

  useEffect(() => {
    if (strategy) {
      setName(strategy.name)
      setIconKeyword(strategy.icon_keyword)
      setPrompt(strategy.prompt)
      setTaskType(strategy.task_type)
      setParamsJson(strategy.parameters)
    } else {
      setName('')
      setIconKeyword('')
      setPrompt('')
      setTaskType('custom')
      setParamsJson('[]')
    }
  }, [strategy, open])

  const Icon = matchIcon(iconKeyword, name)

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = {
        name, icon_keyword: iconKeyword, prompt, task_type: taskType,
        parameters: paramsJson, sort_order: 99,
      }
      const url = isEdit ? `${API}/${strategy!.id}` : API
      return apiFetchRaw(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    },
    onSuccess: () => {
      toast.success(isEdit ? '策略已更新' : '策略已创建')
      queryClient.invalidateQueries({ queryKey: ['strategies'] })
      onSaved()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiFetchRaw(`${API}/${strategy!.id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('已删除')
      queryClient.invalidateQueries({ queryKey: ['strategies'] })
      onSaved()
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[15px] flex items-center gap-2">
            <Icon size={16} />
            {isEdit ? '编辑策略' : '新建策略'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-[12px] text-foreground/50">策略名称</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：日系清新风" className="h-8 text-[13px]" />
            </div>
            <div className="w-28 space-y-1">
              <label className="text-[12px] text-foreground/50">图标关键词</label>
              <Input value={iconKeyword} onChange={(e) => setIconKeyword(e.target.value)} placeholder="自动匹配" className="h-8 text-[13px]" />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">Prompt 模板</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述如何变换图片... 可用变量: {style}, {season}, {ratio} 等"
              className="min-h-[120px] text-[13px] font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50 inline-flex items-center gap-1">
              参数配置 (JSON)
              <InfoHint text={'每个参数: { name, label, type: "select"|"input"|"slider", options?, default? }'} />
            </label>
            <Textarea
              value={paramsJson}
              onChange={(e) => setParamsJson(e.target.value)}
              placeholder='[{"name":"style","label":"风格","type":"select","options":["日系","胶片"],"default":"日系"}]'
              className="min-h-[80px] text-[12px] font-mono"
            />
          </div>

          <div className="flex items-center gap-2 text-[12px] text-foreground/40">
            <span>图标预览:</span>
            <Icon size={16} className="text-accent" />
            <span className="text-foreground/60">{name || '策略名称'}</span>
          </div>
        </div>

        <DialogFooter>
          {isEdit && !strategy?.is_builtin && (
            <Button variant="outline" size="sm" className="text-destructive mr-auto" onClick={() => deleteMutation.mutate()}>
              删除策略
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!name || !prompt || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
