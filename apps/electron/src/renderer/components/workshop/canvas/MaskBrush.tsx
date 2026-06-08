import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import { Layer, Line, Rect } from 'react-konva'
import type Konva from 'konva'

export interface MaskBrushHandle {
  /** 把当前涂抹区域导出为 white-on-black PNG(底模 mask 标准:白=改 黑=保) */
  exportMask: () => Promise<string>     // base64 PNG (without data: prefix)
  undoStroke: () => void
  clearAll: () => void
  hasStrokes: () => boolean
}

interface Stroke {
  points: number[]   // [x1,y1,x2,y2,...] in CANVAS coords
  brushSize: number
}

interface MaskBrushProps {
  /** 选中对象在画布坐标系里的 bounds — 画笔只能在这范围内涂(超出 ignore) */
  objBounds: { x: number; y: number; width: number; height: number }
  /** 当前画笔粗细(画布逻辑像素) */
  brushSize: number
  /** 当前 viewport scale — 用于把屏幕事件坐标转回画布坐标(stage 已经处理了,这里只是参考) */
  active: boolean
  /** 笔触数量变化时通知父组件(让 MaskToolbar 的"生成 / 撤销"按钮能联动 enable/disable) */
  onStrokesChange?: (hasStrokes: boolean) => void
}

/**
 * 在 CanvasStage 内挂载的画笔层,用于涂抹 inpaint / eraser 的 mask 区域。
 *
 * 实现细节:
 *   - 监听 Konva Stage 的 mousedown / mousemove / mouseup
 *   - 鼠标在 objBounds 内时,记录笔触为 Konva.Line(stroke=accent 紫半透,让用户看见)
 *   - exportMask 用一个独立的 off-screen canvas 重绘 white-on-black 版,符合底模 mask 标准
 *   - undoStroke 弹出最近一笔;clearAll 清空所有
 *
 * 由父组件(CanvasStage)用 ref 调用 exportMask / undoStroke / clearAll。
 */
export const MaskBrush = forwardRef<MaskBrushHandle, MaskBrushProps>(function MaskBrush(
  { objBounds, brushSize, active, onStrokesChange }, ref,
) {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const drawingRef = useRef<{ stroke: Stroke } | null>(null)
  const layerRef = useRef<Konva.Layer>(null)

  // 推送 hasStrokes 变化给父组件,驱动 MaskToolbar 的按钮 enable/disable
  useEffect(() => {
    onStrokesChange?.(strokes.length > 0)
  }, [strokes.length, onStrokesChange])

  // 通过 Konva Layer 拿到 stage,挂事件
  useEffect(() => {
    if (!active) return
    const layer = layerRef.current
    if (!layer) return
    const stage = layer.getStage()
    if (!stage) return

    const inBounds = (x: number, y: number) =>
      x >= objBounds.x && x <= objBounds.x + objBounds.width &&
      y >= objBounds.y && y <= objBounds.y + objBounds.height

    const getCanvasPoint = () => {
      const pos = stage.getPointerPosition()
      if (!pos) return null
      const transform = stage.getAbsoluteTransform().copy().invert()
      return transform.point(pos)
    }

    const onDown = () => {
      const pt = getCanvasPoint()
      if (!pt || !inBounds(pt.x, pt.y)) return
      drawingRef.current = {
        stroke: { points: [pt.x, pt.y], brushSize },
      }
      setStrokes((prev) => [...prev, drawingRef.current!.stroke])
    }
    const onMove = () => {
      if (!drawingRef.current) return
      const pt = getCanvasPoint()
      if (!pt) return
      // clamp to bounds — 超出部分截断,避免笔画跑出图外
      const cx = Math.max(objBounds.x, Math.min(objBounds.x + objBounds.width, pt.x))
      const cy = Math.max(objBounds.y, Math.min(objBounds.y + objBounds.height, pt.y))
      drawingRef.current.stroke.points = [...drawingRef.current.stroke.points, cx, cy]
      setStrokes((prev) => [...prev.slice(0, -1), drawingRef.current!.stroke])
    }
    const onUp = () => { drawingRef.current = null }

    stage.on('mousedown.maskbrush touchstart.maskbrush', onDown)
    stage.on('mousemove.maskbrush touchmove.maskbrush', onMove)
    stage.on('mouseup.maskbrush touchend.maskbrush', onUp)
    return () => {
      stage.off('mousedown.maskbrush touchstart.maskbrush')
      stage.off('mousemove.maskbrush touchmove.maskbrush')
      stage.off('mouseup.maskbrush touchend.maskbrush')
    }
  }, [active, objBounds.x, objBounds.y, objBounds.width, objBounds.height, brushSize])

  useImperativeHandle(ref, () => ({
    exportMask: async () => {
      // 画一张和原图同尺寸的离屏 canvas,黑底白笔(底模 mask 标准)
      const off = document.createElement('canvas')
      off.width = Math.round(objBounds.width)
      off.height = Math.round(objBounds.height)
      const ctx = off.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, off.width, off.height)
      ctx.strokeStyle = '#fff'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      // 注意:strokes 用的是 CANVAS 坐标,要先减去 objBounds.x/y 才落在 mask 画布上
      for (const s of strokes) {
        ctx.lineWidth = s.brushSize
        if (s.points.length < 2) continue
        ctx.beginPath()
        ctx.moveTo(s.points[0] - objBounds.x, s.points[1] - objBounds.y)
        for (let i = 2; i < s.points.length; i += 2) {
          ctx.lineTo(s.points[i] - objBounds.x, s.points[i + 1] - objBounds.y)
        }
        ctx.stroke()
      }
      return new Promise<string>((resolve, reject) => {
        off.toBlob((blob) => {
          if (!blob) { reject(new Error('blob failed')); return }
          const reader = new FileReader()
          reader.onload = () => {
            const dataUrl = String(reader.result || '')
            const comma = dataUrl.indexOf(',')
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl)
          }
          reader.onerror = () => reject(reader.error || new Error('read failed'))
          reader.readAsDataURL(blob)
        }, 'image/png')
      })
    },
    undoStroke: () => setStrokes((prev) => prev.slice(0, -1)),
    clearAll: () => setStrokes([]),
    hasStrokes: () => strokes.length > 0,
  }), [strokes, objBounds.x, objBounds.y, objBounds.width, objBounds.height])

  return (
    <Layer ref={layerRef} listening={false}>
      {/* 半透明蒙层:整张选中图盖一层暗色,让用户看清未涂区域 */}
      <Rect
        x={objBounds.x} y={objBounds.y}
        width={objBounds.width} height={objBounds.height}
        fill="rgba(0,0,0,0.35)"
      />
      {/* 笔触显示(UI 层 — 紫色半透,跟最终 export 的 white 不同) */}
      {strokes.map((s, i) => (
        <Line
          key={i}
          points={s.points}
          stroke="rgba(124, 58, 237, 0.55)"
          strokeWidth={s.brushSize}
          lineCap="round"
          lineJoin="round"
          tension={0}
          globalCompositeOperation="source-over"
        />
      ))}
    </Layer>
  )
})
