import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAtom } from 'jotai'
import { cn } from '@/lib/utils'
import { matchIcon } from '@/lib/icon-map'
import { workshopPresetAtom } from '@/atoms/workshop'
import { StrategyPage } from '@/components/workshop/StrategyPage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FieldConfig } from '@/components/workshop/ParameterForm'

interface StrategyRecord {
  id: string
  name: string
  icon_keyword: string
  task_type: string
  prompt: string
  parameters: string
  sort_order: number
  is_builtin: boolean
  enabled: boolean
}

const API = 'http://localhost:7879/api/strategies'

export default function AIWorkshop() {
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string>('')
  const [preset, setPreset] = useAtom(workshopPresetAtom)
  const [showCreate, setShowCreate] = useState(false)
  const [editingStrategy, setEditingStrategy] = useState<StrategyRecord | null>(null)

  const { data: strategies, isLoading } = useQuery<StrategyRecord[]>({
    queryKey: ['strategies'],
    queryFn: () => fetch(API).then((r) => r.json()),
  })

  // Auto-select first strategy
  useEffect(() => {
    if (strategies?.length && !activeId) {
      setActiveId(strategies[0].id)
    }
  }, [strategies, activeId])

  // Handle preset from CoverageMatrix
  useEffect(() => {
    if (preset && strategies) {
      const match = strategies.find((s) => s.task_type === preset.strategy)
      if (match) setActiveId(match.id)
    }
  }, [preset, strategies])

  const activeStrategy = useMemo(
    () => strategies?.find((s) => s.id === activeId) || null,
    [strategies, activeId],
  )

  const activeFields: FieldConfig[] = useMemo(() => {
    if (!activeStrategy) return []
    try { return JSON.parse(activeStrategy.parameters) } catch { return [] }
  }, [activeStrategy])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30">
        加载策略...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 h-[48px] shrink-0 border-b border-foreground/5">
        <h1 className="text-[15px] font-semibold text-foreground">AI工坊</h1>
        <Button variant="outline" size="sm" className="text-[12px] h-7" onClick={() => setShowCreate(true)}>
          <Plus size={12} className="mr-1" /> 新建策略
        </Button>
      </div>

      {/* Strategy tabs */}
      <div className="px-6 pt-3 shrink-0">
        <div className="flex gap-1 flex-wrap">
          {strategies?.map((s) => {
            const Icon = matchIcon(s.icon_keyword, s.name)
            const isActive = activeId === s.id
            return (
              <button
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors group',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                )}
              >
                <Icon size={14} strokeWidth={1.5} />
                {s.name}
                {!s.is_builtin && (
                  <button
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 ml-0.5"
                    onClick={(e) => { e.stopPropagation(); setEditingStrategy(s) }}
                  >
                    <Settings2 size={11} />
                  </button>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
        {activeStrategy ? (
          <StrategyPage
            key={activeStrategy.id}
            taskType={activeStrategy.task_type}
            fields={activeFields}
            strategyId={activeStrategy.id}
          />
        ) : (
          <div className="text-center py-20 text-[13px] text-foreground/30">
            选择或创建一个策略
          </div>
        )}
      </div>

      {/* Create / Edit Dialog */}
      <StrategyDialog
        open={showCreate || !!editingStrategy}
        onClose={() => { setShowCreate(false); setEditingStrategy(null) }}
        strategy={editingStrategy}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['strategies'] })
          setShowCreate(false)
          setEditingStrategy(null)
        }}
      />
    </div>
  )
}

function StrategyDialog({ open, onClose, strategy, onSaved }: {
  open: boolean; onClose: () => void; strategy: StrategyRecord | null; onSaved: () => void
}) {
  const isEdit = !!strategy
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
      const body = { name, icon_keyword: iconKeyword, prompt, task_type: taskType, parameters: paramsJson, sort_order: 99 }
      const url = isEdit ? `${API}/${strategy!.id}` : API
      return fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    },
    onSuccess: () => { toast.success(isEdit ? '策略已更新' : '策略已创建'); onSaved() },
  })

  const deleteMutation = useMutation({
    mutationFn: () => fetch(`${API}/${strategy!.id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => { toast.success('已删除'); onSaved() },
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
            <label className="text-[12px] text-foreground/50">参数配置 (JSON)</label>
            <Textarea
              value={paramsJson}
              onChange={(e) => setParamsJson(e.target.value)}
              placeholder='[{"name":"style","label":"风格","type":"select","options":["日系","胶片"],"default":"日系"}]'
              className="min-h-[80px] text-[12px] font-mono"
            />
            <p className="text-[10px] text-foreground/30">
              每个参数: {`{ name, label, type: "select"|"input"|"slider", options?, default? }`}
            </p>
          </div>

          {/* Icon preview */}
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
