import { useCallback, useState } from 'react'

import { api } from '@/lib/api'

/**
 * 串行触发流水线 6 个阶段。每步用工具栏的 sane defaults，参数由后端兜底。
 *
 * 设计：
 *   - **客户端串行**而非后端 orchestration。理由：可中断 / 可观察 / 不需要新后端
 *     route，并且失败时用户能在每个阶段独立查日志
 *   - **轮询完成**：通过 `api.tasks.get(id)` 每 2s poll 一次，状态变 `completed` /
 *     `failed` / `cancelled` 时进入下一步
 *   - **错误处理**：任意阶段失败 → 抛错给调用方；caller 决定 toast / 是否跳过续跑
 */

export type PipelineStage =
  | 'scan'
  | 'quality_check'
  | 'orient'
  | 'dedup'
  | 'tag'
  | 'embed'

export const STAGE_LABELS: Record<PipelineStage, string> = {
  scan:          '扫描图片',
  quality_check: '质量检查',
  orient:        '视角纠正',
  dedup:         '去重',
  tag:           '智能打标',
  embed:         '向量化',
}

const STAGES: PipelineStage[] = ['scan', 'quality_check', 'orient', 'dedup', 'tag', 'embed']

/** Stage 之间的默认参数。和各 Tab 的 useState 默认对齐，保持行为一致。 */
function defaultParams(stage: PipelineStage, opts: { directory?: string }): Record<string, unknown> {
  switch (stage) {
    case 'scan':
      return { directory: opts.directory }
    case 'quality_check':
      return {
        min_resolution: 720,
        blur_threshold: 80,
        brightness_min: 30,
        brightness_max: 225,
      }
    case 'orient':
      return {}
    case 'dedup':
      return {
        mode: 'balanced',
        threshold: 8,
        use_semantic: false,
        semantic_mode: 'balanced',
        semantic_threshold: 0.92,
      }
    case 'tag':
      return { concurrency: 24 }
    case 'embed':
      return { force: false }
  }
}

const POLL_INTERVAL_MS = 2000
const MAX_POLLS = 1800   // 1800 × 2s = 60 min hard cap per stage

interface RunState {
  status: 'idle' | 'running' | 'success' | 'failed'
  currentStage: PipelineStage | null
  currentIndex: number
  totalStages: number
  error?: string
  failedStage?: PipelineStage
}

interface UsePipelineRunAllResult {
  state: RunState
  /** 启动串行流水线。返回 promise 在全部成功 / 任意失败时 resolve / reject */
  run: (opts: { directory: string }) => Promise<void>
  /** 重置状态到 idle（不会取消运行中的任务，需用户去任务中心手动取消） */
  reset: () => void
}

export function usePipelineRunAll(projectId: string | null): UsePipelineRunAllResult {
  const [state, setState] = useState<RunState>({
    status: 'idle',
    currentStage: null,
    currentIndex: 0,
    totalStages: STAGES.length,
  })

  const reset = useCallback(() => {
    setState({ status: 'idle', currentStage: null, currentIndex: 0, totalStages: STAGES.length })
  }, [])

  const run = useCallback(async ({ directory }: { directory: string }) => {
    if (!projectId) throw new Error('请先选择或创建项目')
    if (!directory) throw new Error('请提供图片目录')

    setState({ status: 'running', currentStage: STAGES[0], currentIndex: 0, totalStages: STAGES.length })

    for (let i = 0; i < STAGES.length; i++) {
      const stage = STAGES[i]
      setState((s) => ({ ...s, currentStage: stage, currentIndex: i }))

      let taskId: string
      try {
        const params = defaultParams(stage, { directory })
        const result = await api.tasks.create(stage, { project_id: projectId, ...params })
        taskId = result.task_id
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        setState({ status: 'failed', currentStage: stage, currentIndex: i, totalStages: STAGES.length, error: msg, failedStage: stage })
        throw new Error(`${STAGE_LABELS[stage]}启动失败：${msg}`)
      }

      // Poll until terminal status
      let polls = 0
      while (polls < MAX_POLLS) {
        await sleep(POLL_INTERVAL_MS)
        polls++
        let task
        try {
          task = await api.tasks.get(taskId)
        } catch (e: any) {
          // Only transient fetch errors are swallowed. Terminal task errors
          // are handled outside this catch so they cannot be mistaken for a
          // temporary polling failure and spin until the 60-minute timeout.
          if (polls >= MAX_POLLS) {
            setState({ status: 'failed', currentStage: stage, currentIndex: i, totalStages: STAGES.length, error: '轮询超时', failedStage: stage })
            throw e
          }
          continue
        }

        if (task.status === 'completed') break
        if (task.status === 'failed' || task.status === 'cancelled') {
          const reason = task.error_message || '任务失败'
          setState({ status: 'failed', currentStage: stage, currentIndex: i, totalStages: STAGES.length, error: reason, failedStage: stage })
          throw new Error(`${STAGE_LABELS[stage]}：${reason}`)
        }
      }

      if (polls >= MAX_POLLS) {
        setState({ status: 'failed', currentStage: stage, currentIndex: i, totalStages: STAGES.length, error: `${STAGE_LABELS[stage]}超时（>60min）`, failedStage: stage })
        throw new Error(`${STAGE_LABELS[stage]}超时`)
      }
    }

    setState({ status: 'success', currentStage: null, currentIndex: STAGES.length, totalStages: STAGES.length })
  }, [projectId])

  return { state, run, reset }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
