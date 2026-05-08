import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ShieldCheck, Copy, Sparkles, Tags, RotateCw, Loader2, Wand2 } from 'lucide-react'
import { apiFetchRaw } from '@/lib/api'

import { TabPage } from '@/components/shared/TabPage'
import { Button } from '@/components/ui/button'
import { activeProjectIdAtom } from '@/atoms/project'
import { usePipelineRunAll, STAGE_LABELS } from '@/hooks/usePipelineRunAll'
import { QualityCheckTab } from './pipeline/QualityCheckTab'
import { DedupTab } from './pipeline/DedupTab'
import { EmbedTab } from './pipeline/EmbedTab'
import { TaggingTab } from './pipeline/TaggingTab'
import { OrientTab } from './pipeline/OrientTab'

const TABS = [
  { id: 'quality-check', label: '质量检查', icon: ShieldCheck, content: <QualityCheckTab /> },
  { id: 'orient',        label: '视角纠正', icon: RotateCw,    content: <OrientTab /> },
  { id: 'dedup',         label: '去重',     icon: Copy,        content: <DedupTab /> },
  { id: 'tagging',       label: '标注',     icon: Tags,        content: <TaggingTab /> },
  { id: 'embed',         label: '向量化',   icon: Sparkles,    content: <EmbedTab /> },
]

interface ProjectInfo {
  id: string
  name: string
  originals_path: string
}

export default function Pipeline() {
  const [activeTab, setActiveTab] = useState('quality-check')
  const projectId = useAtomValue(activeProjectIdAtom)

  // Resolve current project's source directory for the run-all button.
  const { data: projects } = useQuery<ProjectInfo[]>({
    queryKey: ['projects'],
    queryFn: () => apiFetchRaw('/projects').then((r) => r.json()),
  })
  const currentProject = projects?.find((p) => p.id === projectId)

  const { state, run } = usePipelineRunAll(projectId)

  // Surface terminal states as toasts so the user gets feedback even if they
  // navigated away from the Pipeline page.
  useEffect(() => {
    if (state.status === 'success') {
      toast.success('一键流水线全部完成', {
        description: `${state.totalStages} 个阶段已跑完，可以去资产库查看结果`,
      })
    } else if (state.status === 'failed') {
      toast.error(`「${state.failedStage ? STAGE_LABELS[state.failedStage] : ''}」阶段失败`, {
        description: state.error,
      })
    }
  }, [state.status, state.error, state.failedStage, state.totalStages])

  const isRunning = state.status === 'running'
  const canRun = !!projectId && !!currentProject?.originals_path && !isRunning

  const handleRunAll = async () => {
    if (!currentProject?.originals_path) {
      toast.error('当前项目没有图片目录，请先创建项目并选目录')
      return
    }
    try {
      await run({ directory: currentProject.originals_path })
    } catch {
      // toast 已经在 useEffect 弹了
    }
  }

  const actions = (
    <div className="flex items-center gap-2">
      {isRunning && state.currentStage && (
        <span className="text-[11.5px] text-foreground/55 whitespace-nowrap">
          {state.currentIndex + 1}/{state.totalStages} {STAGE_LABELS[state.currentStage]}
        </span>
      )}
      <Button
        size="sm"
        onClick={handleRunAll}
        disabled={!canRun}
        title={!projectId ? '请先选择项目' : !currentProject?.originals_path ? '当前项目无图片目录' : '一键串行跑全部 6 个阶段'}
      >
        {isRunning ? (
          <Loader2 size={12} className="animate-spin mr-1.5" />
        ) : (
          <Wand2 size={12} className="mr-1.5" />
        )}
        一键处理
      </Button>
    </div>
  )

  return (
    <TabPage
      title="流水线"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      actions={actions}
    />
  )
}
