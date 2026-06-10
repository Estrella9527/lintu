import { toast } from 'sonner'

import { jotaiStore } from '@/lib/jotaiStore'
import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import {
  canvasObjectsAtom, canvasSnapshotsAtom,
  type CanvasImageObject, type CanvasObject, type CanvasPlaceholderObject,
} from '@/atoms/canvas'
import type { GenerationCandidate } from '@/lib/canvasGenerate'

/** 候选 → 画布图对象(以占位框中心为锚定,模型返回尺寸略有出入时不跳位) */
function candidateToImage(
  ph: Pick<CanvasPlaceholderObject, 'id' | 'x' | 'y' | 'width' | 'height' | 'sourceObjectIds'>,
  cand: GenerationCandidate,
  withSrc: boolean,
): CanvasImageObject {
  const cx = ph.x + ph.width / 2
  const cy = ph.y + ph.height / 2
  const nw = cand.w || ph.width
  const nh = cand.h || ph.height
  return {
    type: 'image',
    id: ph.id,                      // 复用占位 id,选中态/关联线无缝延续
    image_id: cand.image_id,
    src: withSrc ? api.images.fileUrl(cand.image_id) : '',  // 快照里 src 本就 strip,恢复时重建
    x: cx - nw / 2,
    y: cy - nh / 2,
    width: nw,
    height: nh,
    rotation: 0,
    selected: false,
    sourceObjectIds: ph.sourceObjectIds,
  }
}

/**
 * 生成结果投递(必达):无论用户此刻在哪,结果图都落到发起它的画布上。
 *
 * 三级路径(6.10 反馈 P0「画布上生成的图显示不出来,只能去历史找」):
 *   1. 还在发起项目 & 占位框在 → 原地替换
 *   2. 还在发起项目 & 占位框没了(被删/被覆盖)→ 结果图直接加进画布
 *   3. 已切到别的项目 → 直接写回发起项目的画布存档,切回即见
 */
export function deliverGenerationResult(
  originProjectId: string,
  placeholder: CanvasPlaceholderObject,
  cand: GenerationCandidate,
): void {
  const currentProject = jotaiStore.get(activeProjectIdAtom)

  if (currentProject === originProjectId) {
    let replaced = false
    jotaiStore.set(canvasObjectsAtom, (prev: CanvasObject[]) => {
      const hit = prev.some((o) => o.id === placeholder.id)
      replaced = hit
      if (hit) {
        return prev.map((o) => (o.id === placeholder.id ? candidateToImage(placeholder, cand, true) : o))
      }
      // 占位没了(用户删了/画布被重载)→ 加回原坐标,不丢
      return [...prev, candidateToImage(placeholder, cand, true)]
    })
    if (!replaced) toast.success('生成完成,已加入画布')
    return
  }

  // 跨项目:写回发起项目的存档(占位在则替换,不在则追加)
  jotaiStore.set(canvasSnapshotsAtom, (prev: Record<string, any>) => {
    const snap = prev[originProjectId]
    const img = candidateToImage(placeholder, cand, false)
    const objects: CanvasObject[] = Array.isArray(snap?.objects) ? [...snap.objects] : []
    const at = objects.findIndex((o) => o.id === placeholder.id)
    if (at >= 0) objects[at] = img
    else objects.push(img)
    return {
      ...prev,
      [originProjectId]: {
        ...(snap || { viewport: { scale: 1, x: 0, y: 0 } }),
        objects,
        updated_at: new Date().toISOString(),
      },
    }
  })
  toast.success('生成完成 — 已放回发起它的项目画布,切回该项目即可看到')
}

/** 生成失败投递:占位在 → 转 error;不在 → 仅提示(存档里的 pending 占位由对账器收尾) */
export function deliverGenerationError(
  originProjectId: string,
  placeholderId: string,
  message: string,
): void {
  const currentProject = jotaiStore.get(activeProjectIdAtom)
  if (currentProject === originProjectId) {
    jotaiStore.set(canvasObjectsAtom, (prev: CanvasObject[]) => prev.map((o) =>
      o.id === placeholderId
        ? { ...(o as CanvasPlaceholderObject), status: 'error' as const, errorMessage: message }
        : o,
    ))
  }
  toast.error(`生成失败:${message.slice(0, 120)}`)
}

// ── 对账器:占位框 ←→ 生成历史 ────────────────────────────────────────────

const RECONCILE_WINDOW_MS = 15 * 60_000   // 占位超过 15 分钟仍无果 → 转 error
const EARLY_SLACK_MS = 90_000             // created_at 允许的时钟偏差

/**
 * 把画布上的 pending 占位与生成历史对账:找到匹配(同 prompt、发起之后生成、
 * 未在画布上用过的图)→ 替换;超龄 → 转 error 提示看历史。
 *
 * 覆盖「App 重启 / 切页打断回调」:后端同步生成早已落库,这里把它接回画布。
 * 返回是否还有 pending(调用方据此决定要不要继续轮询)。
 */
export async function reconcilePendingPlaceholders(projectId: string): Promise<boolean> {
  const objects = jotaiStore.get(canvasObjectsAtom)
  const pendings = objects.filter((o): o is CanvasPlaceholderObject =>
    (o as any).type === 'placeholder'
    && (o as CanvasPlaceholderObject).status === 'pending'
    && !!(o as CanvasPlaceholderObject).prompt
    && !!(o as CanvasPlaceholderObject).created_at,
  )
  if (!pendings.length) return false

  let items: Array<{ id: string; created_at: string | null; width: number | null; height: number | null; generation_metadata: any }> = []
  try {
    const res = await api.images.list({
      project_id: projectId, limit: 60, source_type: 'generated',
    })
    items = res.items as any
  } catch {
    return true  // 网络抖动,下轮再试
  }

  const usedImageIds = new Set(
    objects.filter((o) => (o as any).type !== 'placeholder').map((o) => (o as CanvasImageObject).image_id),
  )

  for (const ph of pendings) {
    const phPrompt = (ph.prompt || '').slice(0, 500)
    const match = items.find((img) => {
      if (usedImageIds.has(img.id)) return false
      const metaPrompt = (img.generation_metadata?.prompt as string) || ''
      if (metaPrompt !== phPrompt) return false
      const t = img.created_at ? new Date(img.created_at + (img.created_at.endsWith('Z') ? '' : 'Z')).getTime() : 0
      return t >= (ph.created_at! - EARLY_SLACK_MS)
    })
    if (match) {
      usedImageIds.add(match.id)
      jotaiStore.set(canvasObjectsAtom, (prev: CanvasObject[]) => prev.map((o) =>
        o.id === ph.id
          ? candidateToImage(ph, {
              image_id: match.id, w: match.width || ph.width, h: match.height || ph.height,
            } as GenerationCandidate, true)
          : o,
      ))
    } else if (Date.now() - ph.created_at! > RECONCILE_WINDOW_MS) {
      jotaiStore.set(canvasObjectsAtom, (prev: CanvasObject[]) => prev.map((o) =>
        o.id === ph.id
          ? { ...(o as CanvasPlaceholderObject), status: 'error' as const,
              errorMessage: '生成可能已完成,请查看历史记录;或点重试' }
          : o,
      ))
    }
  }

  return jotaiStore.get(canvasObjectsAtom).some((o) =>
    (o as any).type === 'placeholder' && (o as CanvasPlaceholderObject).status === 'pending')
}
