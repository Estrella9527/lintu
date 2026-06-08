import { useEffect, useRef, useState } from 'react'
import { Group, Rect, Text } from 'react-konva'
import type Konva from 'konva'

import type { CanvasPlaceholderObject } from '@/atoms/canvas'

interface CanvasPlaceholderProps {
  obj: CanvasPlaceholderObject
  isSelected: boolean
  onSelect: () => void
  onRemove: () => void
  onRetry: () => void
}

/**
 * 占位图 — 生成中(pending) / 生成失败(error) 时画布上的可视化占位。
 *
 * 视觉:
 *   - pending:浅灰底 + 虚线描边 + 中心 spinner ring(用 ticker 自旋)+ 顶部 label
 *   - error:浅红底 + 描边 + 中心叉号 + 顶部 label + 底部 error message 截断
 *
 * 交互:
 *   - 点击 → 选中(用户能看到周围有 selection border)
 *   - 选中后右键 / 删除键 → 删除(主调用方处理)
 *   - 失败态:在 PromptBar / ContextBar 的对应入口能"重试"(我们这里只暴露 selected 让外部识别)
 *
 * Konva 渲染:整个用 Group 包,实现 transform 一致。
 */
export function CanvasPlaceholder({
  obj, isSelected, onSelect, onRemove, onRetry,
}: CanvasPlaceholderProps) {
  // 自旋 spinner — Konva 不直接支持 CSS animation,用 RAF 改 rotation
  const [rotation, setRotation] = useState(0)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    if (obj.status !== 'pending') return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      setRotation((r) => (r + dt * 0.18) % 360)  // 0.18 度/ms ≈ 1 圈/2s
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [obj.status])

  const isPending = obj.status === 'pending'
  const bgFill   = isPending ? 'rgba(0,0,0,0.025)' : 'rgba(239, 68, 68, 0.05)'
  const stroke   = isPending ? 'rgba(0,0,0,0.18)' : 'rgba(239, 68, 68, 0.55)'
  const accent   = isPending ? '#7c3aed' : '#ef4444'

  // 中心点(画布坐标)
  const cx = obj.width / 2
  const cy = obj.height / 2

  return (
    <Group
      x={obj.x}
      y={obj.y}
      onMouseDown={onSelect}
      onTap={onSelect}
    >
      {/* 底框 */}
      <Rect
        width={obj.width}
        height={obj.height}
        fill={bgFill}
        stroke={isSelected ? '#7c3aed' : stroke}
        strokeWidth={isSelected ? 2 : 1.5}
        dash={[8, 6]}
        cornerRadius={6}
      />

      {/* 顶部 label 条 */}
      <Rect
        x={12} y={12}
        width={Math.min(obj.width - 24, 360)}
        height={26}
        fill="rgba(255,255,255,0.88)"
        cornerRadius={13}
      />
      <Text
        x={20} y={19}
        width={Math.min(obj.width - 40, 350)}
        text={obj.label}
        fontSize={12}
        fontStyle="500"
        fill={accent}
        ellipsis
        wrap="none"
      />

      {/* 中心:pending → 旋转环 / error → 叉号 */}
      {isPending ? (
        <Group x={cx} y={cy} rotation={rotation}>
          <Rect
            x={-22} y={-22}
            width={44} height={44}
            stroke={accent}
            strokeWidth={3}
            cornerRadius={22}
            dash={[18, 14]}
            opacity={0.6}
          />
        </Group>
      ) : (
        <>
          <Text
            x={cx - 12} y={cy - 22}
            text="✕"
            fontSize={32}
            fontStyle="bold"
            fill={accent}
          />
          {obj.errorMessage && (
            <Text
              x={20} y={obj.height - 56}
              width={obj.width - 40}
              text={obj.errorMessage.slice(0, 200)}
              fontSize={11}
              fill="rgba(120, 0, 0, 0.85)"
              wrap="word"
              align="center"
              height={40}
            />
          )}
        </>
      )}

      {/* 底部状态文字 */}
      <Text
        x={20} y={obj.height - 26}
        width={obj.width - 40}
        text={isPending
          ? '生成中… 切走也不会丢,完成后自动出现在这里'
          : '生成失败 · 选中后按 Delete 删,或在 PromptBar 重试'}
        fontSize={11}
        fill={isPending ? 'rgba(0,0,0,0.45)' : 'rgba(120,0,0,0.65)'}
        align="center"
      />
    </Group>
  )
}
