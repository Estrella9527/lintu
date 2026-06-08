import { useEffect, useRef, useState } from 'react'
import { Image as KonvaImage, Rect, Transformer } from 'react-konva'
import type Konva from 'konva'

import type { CanvasImageObject } from '@/atoms/canvas'

interface CanvasImageProps {
  obj: CanvasImageObject
  isSelected: boolean
  onSelect: () => void
  onChange: (next: CanvasImageObject) => void
  /** Called once after move / resize finishes so history hook can snapshot */
  onCommit: () => void
}

/**
 * 画布上一个图像对象 — 自带选中描边 + transformer (8 手柄缩放)。
 *
 * 注意事项:
 *   - <img> 用 token query 走 /api/images/{id}/file?token=...,避免 401
 *   - Transformer 锁缩放,不锁旋转(Phase 1 不开放旋转 UI 但保留底层能力)
 *   - 移动 / 缩放结束才回调 onCommit;过程中只更新本地视觉,避免 atom 抖动
 *   - 选中描边颜色用 lintu accent (从 CSS var 读)
 */
export function CanvasImage({
  obj, isSelected, onSelect, onChange, onCommit,
}: CanvasImageProps) {
  const imageNodeRef = useRef<Konva.Image>(null)
  const transformerRef = useRef<Konva.Transformer>(null)
  const [htmlImage, setHtmlImage] = useState<HTMLImageElement | null>(null)

  // obj.src 由 CanvasStage 用 api.images.fileUrl() 构造,已含 sidecar host + token,
  // 直接喂给 <img>。手动加载是因为 Konva 要的是 HTMLImageElement,不能用 React 的 <img>。
  //
  // **不要**设 crossOrigin='anonymous' — sidecar 默认不发 CORS 头,设了反而被浏览器
  // 阻断,图永远不进 onload(用户看到的就是"画框无图"的占位 Rect)。
  // 我们也不需要 canvas 读图像像素(MaskBrush 只画自己的笔触),所以无 CORS 需求。
  useEffect(() => {
    const img = new window.Image()
    img.src = obj.src
    img.onload = () => setHtmlImage(img)
    img.onerror = () => {
      console.warn('[canvas] failed to load image', obj.src)
    }
    return () => { img.onload = null; img.onerror = null }
  }, [obj.src])

  // 选中状态切换时,attach transformer 到 image 节点
  useEffect(() => {
    if (isSelected && imageNodeRef.current && transformerRef.current) {
      transformerRef.current.nodes([imageNodeRef.current])
      transformerRef.current.getLayer()?.batchDraw()
    }
  }, [isSelected])

  if (!htmlImage) {
    // 加载中:显示一个底色矩形占位,尺寸用 obj 的预声明值
    return (
      <Rect
        x={obj.x} y={obj.y}
        width={obj.width} height={obj.height}
        fill="rgba(0,0,0,0.04)"
        cornerRadius={4}
      />
    )
  }

  return (
    <>
      <KonvaImage
        ref={imageNodeRef}
        image={htmlImage}
        x={obj.x}
        y={obj.y}
        width={obj.width}
        height={obj.height}
        rotation={obj.rotation}
        draggable
        onMouseDown={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => {
          onChange({ ...obj, x: e.target.x(), y: e.target.y() })
          onCommit()
        }}
        onTransformEnd={() => {
          // Konva 通过 scale 实现缩放,我们把它折算到 width/height,保证后续
          // 编辑操作(任意扩图 / inpaint)读到的尺寸不带 scale 残留。
          const node = imageNodeRef.current
          if (!node) return
          const sx = node.scaleX()
          const sy = node.scaleY()
          node.scaleX(1)
          node.scaleY(1)
          onChange({
            ...obj,
            x: node.x(),
            y: node.y(),
            width: Math.max(16, obj.width * sx),
            height: Math.max(16, obj.height * sy),
            rotation: node.rotation(),
          })
          onCommit()
        }}
      />

      {isSelected && (
        <Transformer
          ref={transformerRef}
          // 8 手柄,Phase 1 不锁比例
          enabledAnchors={[
            'top-left', 'top-center', 'top-right',
            'middle-left', 'middle-right',
            'bottom-left', 'bottom-center', 'bottom-right',
          ]}
          rotateEnabled={false}
          borderStroke="hsl(var(--accent))"
          borderStrokeWidth={1.5}
          anchorStroke="hsl(var(--accent))"
          anchorFill="#ffffff"
          anchorSize={9}
          anchorCornerRadius={2}
          // 不允许缩到 < 16px(否则会有"消失对象"的恼人场景)
          boundBoxFunc={(_oldBox, newBox) => {
            if (Math.abs(newBox.width) < 16 || Math.abs(newBox.height) < 16) {
              return _oldBox
            }
            return newBox
          }}
        />
      )}
    </>
  )
}
