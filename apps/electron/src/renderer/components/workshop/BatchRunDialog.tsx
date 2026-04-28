import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'

import { api, type PromptRecord } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import { SeedSelector } from '@/components/workshop/SeedSelector'
import type { ImageRecord } from '@/lib/types'

const TASK_TYPES = [
  { value: 'outpaint', label: '画布扩展 (outpaint)' },
  { value: 'style', label: '风格变换 (style)' },
  { value: 'seasonal', label: '季节变换 (seasonal)' },
  { value: 'inpaint', label: '局部编辑 (inpaint)' },
  { value: 'custom', label: '自定义 (custom)' },
]

// Rough heuristics — show user a ballpark, not a contract
const AVG_SECONDS_PER_IMAGE = 15
const AVG_COST_PER_IMAGE_USD = 0.02

interface BatchRunDialogProps {
  open: boolean
  onClose: () => void
  defaultTaskType?: string
  defaultStrategyId?: string
  /** Preselected seeds when launched from elsewhere (e.g., Asset Library). */
  initialSeeds?: ImageRecord[]
  /** Optional full-config preset for "复用批次配置" — when present
   * everything is prefilled and the dialog opens ready-to-launch. */
  preset?: {
    name?: string
    promptIds?: string[]
    concurrency?: number
    maxRetry?: number
    budgetUsd?: number | null
    providerChain?: string[] | null
  }
  onCreated?: (batchId: string) => void
}

export function BatchRunDialog({
  open,
  onClose,
  defaultTaskType,
  defaultStrategyId,
  initialSeeds,
  preset,
  onCreated,
}: BatchRunDialogProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [taskType, setTaskType] = useState(defaultTaskType || 'outpaint')
  const [seeds, setSeeds] = useState<ImageRecord[]>([])
  const [selectedPromptIds, setSelectedPromptIds] = useState<Set<string>>(new Set())
  const [promptSearch, setPromptSearch] = useState('')
  const [concurrency, setConcurrency] = useState(3)
  const [maxRetry, setMaxRetry] = useState(2)
  const [budget, setBudget] = useState<string>('')
  const [providerChain, setProviderChain] = useState('')

  // Reset on open. When `preset` is provided we treat this as a clone and
  // pre-fill every editable field — name gets a "(复用)" prefix so the
  // user knows what they're looking at.
  useEffect(() => {
    if (open) {
      const fromLib = initialSeeds && initialSeeds.length > 0
      const stamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      setName(
        preset?.name
          ? `${preset.name} (复用 · ${stamp})`
          : fromLib
            ? `资产库选 ${initialSeeds!.length} 张 · ${stamp}`
            : `批次 ${stamp}`,
      )
      setTaskType(defaultTaskType || 'outpaint')
      setSeeds(initialSeeds || [])
      setSelectedPromptIds(new Set(preset?.promptIds || []))
      setPromptSearch('')
      setConcurrency(preset?.concurrency ?? 3)
      setMaxRetry(preset?.maxRetry ?? 2)
      setBudget(preset?.budgetUsd != null ? String(preset.budgetUsd) : '')
      setProviderChain((preset?.providerChain || []).join(', '))
    }
  }, [open, defaultTaskType, initialSeeds, preset])

  const { data: prompts } = useQuery<PromptRecord[]>({
    queryKey: ['prompts', 'all-active'],
    queryFn: () => api.prompts.list({ is_active: true }),
    enabled: open,
  })

  const filteredPrompts = useMemo(() => {
    let list = prompts ?? []
    if (taskType) {
      // Show prompts that match the chosen task_type, plus task_type-agnostic ones
      list = list.filter((p) => !p.task_type || p.task_type === taskType)
    }
    if (promptSearch.trim()) {
      const q = promptSearch.toLowerCase()
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q) ||
          (p.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      )
    }
    return list
  }, [prompts, taskType, promptSearch])

  const togglePrompt = (id: string) => {
    const next = new Set(selectedPromptIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedPromptIds(next)
  }

  const total = seeds.length * selectedPromptIds.size
  const estSeconds = Math.round((total * AVG_SECONDS_PER_IMAGE) / Math.max(concurrency, 1))
  const estCost = (total * AVG_COST_PER_IMAGE_USD).toFixed(2)

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!projectId) throw new Error('未选择项目')
      const chain = providerChain
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const created = await api.batches.create({
        project_id: projectId,
        name: name.trim() || `批次 ${Date.now()}`,
        task_type: taskType,
        strategy_id: defaultStrategyId,
        seed_image_ids: seeds.map((s) => s.id),
        prompt_ids: Array.from(selectedPromptIds),
        concurrency,
        max_retry: maxRetry,
        provider_chain: chain.length ? chain : undefined,
        budget_usd: budget ? Number(budget) : undefined,
      })
      await api.batches.start(created.id)
      return created
    },
    onSuccess: (batch) => {
      toast.success(`批次已启动：${batch.total} 个 subtask 排队中`)
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      onCreated?.(batch.id)
      onClose()
    },
    onError: (e: Error) => toast.error(`启动失败：${e.message}`),
  })

  const canSubmit =
    !!projectId && seeds.length > 0 && selectedPromptIds.size > 0 && !createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">批量生产</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name + task_type */}
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-[12px] text-foreground/50">批次名称</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：Sandu 夏季漂流首轮"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="w-48 space-y-1">
              <label className="text-[12px] text-foreground/50">引擎类型</label>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                className="w-full h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
              >
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Seeds */}
          <div className="space-y-1.5">
            <label className="text-[12px] text-foreground/50">种子图（来自资产库）</label>
            <SeedSelector selectedImages={seeds} onSelect={setSeeds} />
          </div>

          {/* Prompts */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-foreground/50">
                Prompt 模板
                <span className="ml-2 text-foreground/40">
                  已选 {selectedPromptIds.size} / 可选 {filteredPrompts.length}
                </span>
              </label>
              <div className="flex gap-2">
                <Input
                  value={promptSearch}
                  onChange={(e) => setPromptSearch(e.target.value)}
                  placeholder="搜索 prompt"
                  className="h-7 w-40 text-[12px]"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    if (selectedPromptIds.size === filteredPrompts.length) {
                      setSelectedPromptIds(new Set())
                    } else {
                      setSelectedPromptIds(new Set(filteredPrompts.map((p) => p.id)))
                    }
                  }}
                >
                  {selectedPromptIds.size === filteredPrompts.length ? '全不选' : '全选'}
                </Button>
              </div>
            </div>
            <div className="rounded-md border border-foreground/10 max-h-[220px] overflow-y-auto">
              {filteredPrompts.length === 0 ? (
                <div className="text-center py-8 text-[12px] text-foreground/40">
                  没有匹配的 prompt。请到「设置 → 提示词库」新建或导入。
                </div>
              ) : (
                <div className="divide-y divide-foreground/5">
                  {filteredPrompts.map((p) => {
                    const checked = selectedPromptIds.has(p.id)
                    return (
                      <label
                        key={p.id}
                        className="flex gap-2 px-3 py-2 cursor-pointer hover:bg-foreground/[0.02]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePrompt(p.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                            <span className="text-[12px] font-medium text-foreground/85 truncate">{p.name}</span>
                            <Badge variant="secondary" className="text-[9px] px-1 py-0">{p.category}</Badge>
                            {p.task_type && (
                              <Badge variant="outline" className="text-[9px] px-1 py-0">{p.task_type}</Badge>
                            )}
                            {(p.version ?? 1) > 1 && (
                              <span className="text-[9px] text-foreground/40">v{p.version}</span>
                            )}
                          </div>
                          <p className="text-[11px] text-foreground/50 line-clamp-1">{p.content}</p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Run config */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">
                并发数 <span className="text-foreground/40">({concurrency})</span>
              </label>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">
                每张最多重试 <span className="text-foreground/40">({maxRetry})</span>
              </label>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={maxRetry}
                onChange={(e) => setMaxRetry(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">预算上限 (USD，可选)</label>
              <Input
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="留空表示不限"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-foreground/50">Provider 链 (可选，逗号分隔)</label>
              <Input
                value={providerChain}
                onChange={(e) => setProviderChain(e.target.value)}
                placeholder="留空使用默认链"
                className="h-8 text-[13px]"
              />
            </div>
          </div>

          {/* Estimate */}
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3 text-[12px] text-foreground/70">
            <div className="font-medium mb-1">预估</div>
            <div>
              共 <span className="text-foreground">{seeds.length}</span> 张种子 × <span className="text-foreground">{selectedPromptIds.size}</span> 条 prompt
              = <span className="text-info font-medium">{total}</span> 张
            </div>
            <div className="text-foreground/55 mt-0.5">
              耗时约 {estSeconds >= 3600 ? `${(estSeconds / 3600).toFixed(1)} 小时` : `${Math.max(1, Math.round(estSeconds / 60))} 分钟`}
              {' · '}成本约 ${estCost}（按 ${AVG_COST_PER_IMAGE_USD}/张 估算，实际以 provider 为准）
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? '启动中…' : `启动批次（${total} 张）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
