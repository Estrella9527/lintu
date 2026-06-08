import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Arrow, Group } from 'react-konva'

import {
  canvasObjectsAtom, canvasViewportAtom, selectedObjectIdAtom,
} from '@/atoms/canvas'
import { accentColor, accentColorAlpha } from '@/lib/canvasColors'

/**
 * 关联线层 —— 把「由某张图发散出来的图」用带箭头的曲线连回它的源对象,
 * 形成发散式创作树(源图 → 多张衍生图 呈放射状)。
 *
 * 数据:每个对象的 sourceObjectIds 指向它的来源对象 id(img2img / Ask AI /
 * 扩图 等操作在生成时写入)。本层从每个 source 画一条曲线箭头指向该对象。
 *
 * 渲染:作为 Layer 的第一个子节点 → 落在所有图片之下,线从图片背后穿出,
 * 干净不挡图。listening=false → 不拦截点击,纯装饰。
 *
 * 配色:与选中对象相连的线高亮成实心 accent;其余淡 accent 虚线。线宽/箭头
 * 都除以 viewport.scale,保证缩放时屏幕粗细恒定。
 */

interface RectLike { x: number; y: number; width: number; height: number }

const center = (r: RectLike) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

/** 从 rect 中心朝 towards 方向,求与 rect 边界的交点(让线/箭头停在图片边缘)。 */
function edgePoint(r: RectLike, towards: { x: number; y: number }) {
  const c = center(r)
  const dx = towards.x - c.x
  const dy = towards.y - c.y
  if (dx === 0 && dy === 0) return c
  const tx = dx !== 0 ? (r.width / 2) / Math.abs(dx) : Infinity
  const ty = dy !== 0 ? (r.height / 2) / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

export function CanvasLinks() {
  const objects = useAtomValue(canvasObjectsAtom)
  const selectedId = useAtomValue(selectedObjectIdAtom)
  const viewport = useAtomValue(canvasViewportAtom)
  const scale = viewport.scale || 1

  const links = useMemo(() => {
    const byId = new Map(objects.map((o) => [o.id, o]))
    const out: { from: RectLike; to: RectLike; active: boolean; key: string }[] = []
    for (const o of objects) {
      const srcs = (o as { sourceObjectIds?: string[] }).sourceObjectIds
      if (!srcs || srcs.length === 0) continue
      for (const sid of srcs) {
        const s = byId.get(sid)
        if (!s || s.id === o.id) continue
        out.push({
          from: { x: s.x, y: s.y, width: s.width, height: s.height },
          to: { x: o.x, y: o.y, width: o.width, height: o.height },
          active: selectedId === o.id || selectedId === sid,
          key: `${sid}->${o.id}`,
        })
      }
    }
    return out
  }, [objects, selectedId])

  if (links.length === 0) return null

  const solid = accentColor()
  const faint = accentColorAlpha(0.32)

  return (
    <Group listening={false}>
      {links.map((l) => {
        const sc = center(l.from)
        const tc = center(l.to)
        const start = edgePoint(l.from, tc)
        const end = edgePoint(l.to, sc)
        // 轻微弧线:控制点 = 两端中点沿垂直方向偏移,放射感更自然
        const mx = (start.x + end.x) / 2
        const my = (start.y + end.y) / 2
        const dx = end.x - start.x
        const dy = end.y - start.y
        const len = Math.hypot(dx, dy) || 1
        const bow = Math.min(len * 0.14, 64)
        const cx = mx + (-dy / len) * bow
        const cy = my + (dx / len) * bow
        const color = l.active ? solid : faint
        return (
          <Arrow
            key={l.key}
            points={[start.x, start.y, cx, cy, end.x, end.y]}
            tension={0.45}
            stroke={color}
            fill={color}
            strokeWidth={(l.active ? 2 : 1.4) / scale}
            pointerLength={9 / scale}
            pointerWidth={8 / scale}
            dash={l.active ? undefined : [7 / scale, 5 / scale]}
            lineCap="round"
            lineJoin="round"
            listening={false}
            perfectDrawEnabled={false}
          />
        )
      })}
    </Group>
  )
}
