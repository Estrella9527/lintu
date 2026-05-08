import { useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetchRaw } from '@/lib/api'
import {
  ArrowRight, Check, FolderOpen, Loader2, Sparkles, Wand2,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DirectorySelector } from '@/components/pipeline/DirectorySelector'
import { activeProjectIdAtom } from '@/atoms/project'
import { activeModuleAtom } from '@/atoms/navigation'
import { onboardingDoneAtom, onboardingForceOpenAtom } from '@/atoms/onboarding'
import { usePipelineRunAll, STAGE_LABELS } from '@/hooks/usePipelineRunAll'
import { cn } from '@/lib/utils'

/**
 * 三步引导：建项目 → 选目录（已合并到第 1 步）→ 一键流水线。
 *
 * 触发方式：
 *   - 自动：localStorage.lintu_onboarding_done 不为 true 时，App 启动后弹出
 *   - 手动：设置→关于→「重新观看引导」按钮（onboardingForceOpenAtom）
 *
 * 用户随时可点右上角 X / 跳过 关闭；关闭即视为完成（写 storage）。
 */
type Step = 'create' | 'pipeline' | 'done'

interface ProjectSummary {
  id: string
  name: string
  originals_path: string
}

export function OnboardingFlow() {
  const [done, setDone] = useAtom(onboardingDoneAtom)
  const [forceOpen, setForceOpen] = useAtom(onboardingForceOpenAtom)
  const [step, setStep] = useState<Step>('create')

  const open = forceOpen || !done

  // Reset to step 1 every time the dialog opens — re-watching from scratch
  // is simpler than restoring half-finished state.
  useEffect(() => {
    if (open) setStep('create')
  }, [open])

  const handleClose = () => {
    setDone(true)
    setForceOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose() }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent" />
            欢迎使用灵图
          </DialogTitle>
          <DialogDescription>
            三步上手：建项目 → 选目录 → 一键流水线产出可匹配的图。
          </DialogDescription>
        </DialogHeader>

        <Stepper step={step} />

        <div className="mt-2">
          {step === 'create' && (
            <CreateStep onNext={() => setStep('pipeline')} onSkip={handleClose} />
          )}
          {step === 'pipeline' && (
            <PipelineStep onDone={() => setStep('done')} onSkip={handleClose} />
          )}
          {step === 'done' && <DoneStep onClose={handleClose} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'create',   label: '建项目 + 选目录' },
    { id: 'pipeline', label: '一键流水线' },
    { id: 'done',     label: '完成' },
  ]
  const currentIdx = steps.findIndex((s) => s.id === step)
  return (
    <div className="flex items-center gap-2 py-3">
      {steps.map((s, i) => {
        const isActive = i === currentIdx
        const isDone = i < currentIdx
        return (
          <div key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
            <div
              className={cn(
                'flex items-center justify-center h-6 w-6 rounded-full text-[11px] font-medium shrink-0',
                isDone   && 'bg-accent text-accent-foreground',
                isActive && 'bg-accent/20 text-accent border border-accent',
                !isDone && !isActive && 'bg-foreground/[0.06] text-foreground/45',
              )}
            >
              {isDone ? <Check size={12} /> : i + 1}
            </div>
            <span
              className={cn(
                'text-[12px] truncate',
                isActive ? 'text-foreground/85 font-medium' : 'text-foreground/55',
              )}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-foreground/10" />}
          </div>
        )
      })}
    </div>
  )
}

function CreateStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const queryClient = useQueryClient()
  const setActiveProject = useSetAtom(activeProjectIdAtom)
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')

  const create = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('请填写项目名称')
      if (!dir) throw new Error('请选择图片目录')
      const res = await apiFetchRaw('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), originals_path: dir, workspace_path: dir }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
    onSuccess: (project: ProjectSummary) => {
      setActiveProject(project.id)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(`项目「${project.name}」已创建`)
      onNext()
    },
    onError: (e: any) => toast.error(`创建失败：${e?.message ?? e}`),
  })

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-foreground/5 bg-foreground/[0.02] p-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ob-name" className="text-[12px] text-foreground/75">
            项目名称
          </Label>
          <Input
            id="ob-name"
            value={name}
            placeholder="例如：示例景区A / 示例景区B / 你的景区名"
            onChange={(e) => setName(e.target.value)}
            className="text-[12.5px]"
          />
          <p className="text-[11px] text-foreground/45">一个景区一个项目；后续匹配 / 标签 / 同步都按项目隔离。</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[12px] text-foreground/75">图片目录</Label>
          <DirectorySelector value={dir} onChange={setDir} label="选择目录" />
          <p className="text-[11px] text-foreground/45">
            选你的图片所在文件夹，灵图只读不改原文件。建议挑一个相对干净的子目录开始。
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          跳过引导
        </Button>
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={!name.trim() || !dir || create.isPending}
        >
          {create.isPending ? <Loader2 size={12} className="animate-spin mr-1.5" /> : null}
          下一步：跑流水线
          {!create.isPending && <ArrowRight size={12} className="ml-1" />}
        </Button>
      </div>
    </div>
  )
}

function PipelineStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const setActiveModule = useSetAtom(activeModuleAtom)

  const { data: projects } = useQuery<ProjectSummary[]>({
    queryKey: ['projects'],
    queryFn: () => apiFetchRaw('/projects').then((r) => r.json()),
  })
  const project = projects?.find((p) => p.id === projectId)

  const { state, run } = usePipelineRunAll(projectId)
  const isRunning = state.status === 'running'

  const handleRun = async () => {
    if (!project?.originals_path) {
      toast.error('找不到项目目录')
      return
    }
    try {
      await run({ directory: project.originals_path })
      onDone()
    } catch (e: any) {
      toast.error(`流水线失败：${e?.message ?? e}`)
    }
  }

  const handleManual = () => {
    setActiveModule('pipeline')
    onSkip()
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-foreground/5 bg-foreground/[0.02] p-4 space-y-3">
        <div>
          <h3 className="text-[13px] font-medium text-foreground/85 mb-1">
            一键串行 6 个阶段
          </h3>
          <p className="text-[11.5px] text-foreground/55 leading-relaxed">
            扫描 → 质量检查 → 视角纠正 → 去重 → 智能打标 → 向量化。每步用默认参数，
            完成后图就能在资产库浏览，UGC 也能匹配到了。
          </p>
        </div>
        {isRunning && state.currentStage && (
          <div className="flex items-center gap-2 text-[12px] text-foreground/70 bg-accent/[0.06] rounded-md px-3 py-2">
            <Loader2 size={12} className="animate-spin shrink-0" />
            <span>
              第 {state.currentIndex + 1}/{state.totalStages} 步：{STAGE_LABELS[state.currentStage]}
            </span>
          </div>
        )}
        {state.status === 'failed' && (
          <div className="text-[12px] text-destructive bg-destructive/[0.06] rounded-md px-3 py-2">
            {state.error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={handleManual}>
          手动操作（去流水线 Tab）
        </Button>
        <Button size="sm" onClick={handleRun} disabled={isRunning || !project?.originals_path}>
          {isRunning ? (
            <Loader2 size={12} className="animate-spin mr-1.5" />
          ) : (
            <Wand2 size={12} className="mr-1.5" />
          )}
          {isRunning ? '处理中…' : '一键开跑'}
        </Button>
      </div>
    </div>
  )
}

function DoneStep({ onClose }: { onClose: () => void }) {
  const setActiveModule = useSetAtom(activeModuleAtom)
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-5 text-center space-y-2">
        <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-emerald-500/15 text-emerald-600">
          <Check size={20} />
        </div>
        <h3 className="text-[14px] font-medium text-foreground/85">流水线完成</h3>
        <p className="text-[12px] text-foreground/55">
          去资产库看处理后的图，去匹配实验室试一段 UGC 文案的匹配效果。
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => { setActiveModule('asset-library'); onClose() }}>
          <FolderOpen size={12} className="mr-1.5" />
          去资产库
        </Button>
        <Button size="sm" onClick={onClose}>
          完成
        </Button>
      </div>
    </div>
  )
}
