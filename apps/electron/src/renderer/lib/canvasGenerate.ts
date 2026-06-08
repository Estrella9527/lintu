import { apiFetchRaw } from '@/lib/api'

/**
 * 客户端封装 POST /api/generate — 画布上所有 AI 操作的唯一出口。
 *
 * 设计原则:
 *   - 永远返回结构化对象 { ok, candidates?, error? },调用方用一个分支
 *     就能处理成功 / 失败,不需要 try/catch
 *   - 后端在 GenerationFailure 时返回 200 + { ok: false, error };真正的
 *     HTTP 错误(网络 / 401)我们也包成 { ok: false, error } 给 UI 用
 *   - 不在这里做 toast — UI 自己决定怎么提示(画布右下角 / Dialog 头部)
 */

export type GenerationType =
  | 'text2img' | 'img2img' | 'outpaint' | 'inpaint'
  | 'matting' | 'eraser' | 'upscale' | 'text-zh' | 'edit'

export interface GenerationCandidate {
  image_id: string
  url: string
  thumbnail_url: string
  w: number
  h: number
  seed: number | null
  quality: 'draft' | 'refined'
}

export interface GenerationResponse {
  ok: true
  total_cost_usd: number
  candidates: GenerationCandidate[]
}

export interface GenerationError {
  ok: false
  error: { code: string; message: string }
}

export interface GenerateRequest {
  type: GenerationType
  project_id: string
  prompt?: string
  instruction?: string
  input_image_id?: string
  mask?: string
  target_w?: number
  target_h?: number
  /** outpaint 时:原图在目标 canvas 内的水平 / 垂直对齐位置 */
  align_x?: 'left' | 'center' | 'right'
  align_y?: 'top'  | 'middle' | 'bottom'
  style_archive_id?: string
  strength?: number
  consistency?: number
  speed?: 'draft' | 'refined'
  model_id?: string
  count?: number
}

export async function generateOnCanvas(
  req: GenerateRequest,
): Promise<GenerationResponse | GenerationError> {
  const t0 = performance.now()
  // 日志:画图任务往往要 5-30s,出问题时排查链路很烦。把 request/response 都印出来。
  console.log('[canvasGenerate] →', req.type, {
    project_id: req.project_id,
    prompt: req.prompt?.slice(0, 60),
    instruction: req.instruction?.slice(0, 60),
    input_image_id: req.input_image_id,
    target: req.target_w && req.target_h ? `${req.target_w}x${req.target_h}` : undefined,
    align: req.align_x ? `${req.align_x}/${req.align_y}` : undefined,
    style: req.style_archive_id,
    model: req.model_id,
    count: req.count,
    has_mask: !!req.mask,
  })
  try {
    // 超时兜底:后端单张 provider 调用 read timeout 最长 360s(候选间已并行),
    // 给 400s。没有这层时,sidecar 重载 / 连接挂死会让「生成中」永远转圈,
    // 用户只看到后台已扣费、前端无响应(2026-06-06 实际发生过)。
    const res = await apiFetchRaw('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(400_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[canvasGenerate] ✗ HTTP ${res.status} in ${Math.round(performance.now() - t0)}ms`, text.slice(0, 400))
      return {
        ok: false,
        error: {
          code: `http_${res.status}`,
          message: text.slice(0, 300) || `HTTP ${res.status}`,
        },
      }
    }
    const data = await res.json()
    if (data?.ok === false) {
      console.warn(`[canvasGenerate] ✗ ${data?.error?.code} in ${Math.round(performance.now() - t0)}ms`, data?.error?.message)
      return data as GenerationError
    }
    console.log(`[canvasGenerate] ✓ ${data?.candidates?.length || 0} candidates in ${Math.round(performance.now() - t0)}ms · $${data?.total_cost_usd?.toFixed?.(4)}`)
    return data as GenerationResponse
  } catch (e) {
    console.error(`[canvasGenerate] ✗ network/parse error in ${Math.round(performance.now() - t0)}ms`, e)
    const isTimeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
    return {
      ok: false,
      error: isTimeout
        ? { code: 'timeout', message: '生成超时(>6.5 分钟),费用可能已产生 — 请到历史记录确认结果后再重试' }
        : { code: 'network_error', message: (e as Error).message },
    }
  }
}
