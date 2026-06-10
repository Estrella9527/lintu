import { useEffect, useRef, useState } from 'react'
import { Group, Image as KonvaImage, Rect, Text } from 'react-konva'

import type { CanvasPlaceholderObject } from '@/atoms/canvas'

interface CanvasPlaceholderProps {
  obj: CanvasPlaceholderObject
  isSelected: boolean
  onSelect: () => void
  onRemove: () => void
  onRetry: () => void
  /** 图生图的源对象图片地址 — 作为"预生成骨架"的底图(暗化展示) */
  sourceImageSrc?: string
}

/**
 * 占位图 — 生成中(pending) / 生成失败(error) 时画布上的可视化占位。
 *
 * 视觉(6.11 升级:预生成骨架 + 生成中动效):
 *   - pending(图生图):源图暗化铺底 —— "在这张图上生成中"的预览感
 *   - pending(文生图):内容骨架块(大图区 + 两行文字条),像即将到来的排版
 *   - 统一叠加:对角扫光 shimmer(循环)、边框呼吸、顶部 label + 已耗时
 *   - error:浅红底 + 叉号 + 错误信息(保持原状)
 */
export function CanvasPlaceholder({
  obj, isSelected, onSelect, onRemove, onRetry, sourceImageSrc,
}: CanvasPlaceholderProps) {
  const isPending = obj.status === 'pending'

  // 单一 RAF 驱动所有动效:扫光位移 / 边框呼吸 / 已耗时文案
  const [tick, setTick] = useState(0)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!isPending) return
    const loop = (now: number) => {
      setTick(now)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [isPending])

  // 源图(图生图骨架底)
  const [srcImg, setSrcImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!sourceImageSrc || !isPending) { setSrcImg(null); return }
    const im = new window.Image()
    im.src = sourceImageSrc
    im.onload = () => setSrcImg(im)
    return () => { im.onload = null }
  }, [sourceImageSrc, isPending])

  const W = obj.width
  const H = obj.height
  const accent = isPending ? '#7c3aed' : '#ef4444'

  // 扫光:周期 1.8s,从左外侧扫到右外侧的对角高光带
  const SWEEP_MS = 1800
  const phase = (tick % SWEEP_MS) / SWEEP_MS
  const bandW = Math.max(W * 0.45, 120)
  const bandX = -bandW + phase * (W + bandW * 2)
  // 边框呼吸:0.35 ~ 0.8
  const breath = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(tick / 480))
  // 已耗时
  const elapsedS = obj.created_at ? Math.max(0, Math.floor((Date.now() - obj.created_at) / 1000)) : null
  const elapsedText = elapsedS == null ? '' : elapsedS < 60 ? ` · ${elapsedS}s` : ` · ${Math.floor(elapsedS / 60)}m${elapsedS % 60}s`

  if (!isPending) {
    // ── error 态(保持简洁) ──
    return (
      <Group x={obj.x} y={obj.y} onMouseDown={onSelect} onTap={onSelect}>
        <Rect width={W} height={H} fill="rgba(239,68,68,0.05)"
          stroke={isSelected ? '#7c3aed' : 'rgba(239,68,68,0.55)'}
          strokeWidth={isSelected ? 2 : 1.5} dash={[8, 6]} cornerRadius={6} />
        <Rect x={12} y={12} width={Math.min(W - 24, 360)} height={26}
          fill="rgba(255,255,255,0.88)" cornerRadius={13} />
        <Text x={20} y={19} width={Math.min(W - 40, 350)} text={obj.label}
          fontSize={12} fontStyle="500" fill={accent} ellipsis wrap="none" />
        <Text x={W / 2 - 12} y={H / 2 - 22} text="✕" fontSize={32} fontStyle="bold" fill={accent} />
        {obj.errorMessage && (
          <Text x={20} y={H - 56} width={W - 40} text={obj.errorMessage.slice(0, 200)}
            fontSize={11} fill="rgba(120,0,0,0.85)" wrap="word" align="center" height={40} />
        )}
        <Text x={20} y={H - 26} width={W - 40}
          text="生成失败 · 选中后按 Delete 删,或在输入框重试"
          fontSize={11} fill="rgba(120,0,0,0.65)" align="center" />
      </Group>
    )
  }

  // ── pending 态:骨架 + 动效 ──
  return (
    <Group
      x={obj.x} y={obj.y}
      onMouseDown={onSelect} onTap={onSelect}
      clipFunc={(ctx) => {
        // 圆角裁剪,让底图/扫光不溢出占位框
        const r = 8
        ctx.beginPath()
        ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.arcTo(W, 0, W, r, r)
        ctx.lineTo(W, H - r); ctx.arcTo(W, H, W - r, H, r)
        ctx.lineTo(r, H); ctx.arcTo(0, H, 0, H - r, r)
        ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r)
        ctx.closePath()
      }}
    >
      {/* 底:浅色基底 */}
      <Rect width={W} height={H} fill="rgba(124,58,237,0.04)" />

      {srcImg ? (
        // 图生图:源图暗化铺底 — "正在这张图上生成"
        <>
          <KonvaImage image={srcImg} width={W} height={H} opacity={0.38} />
          <Rect width={W} height={H} fill="rgba(15,10,40,0.42)" />
        </>
      ) : (
        // 文生图:内容骨架块(预排版感)
        <>
          <Rect x={W * 0.08} y={H * 0.10} width={W * 0.84} height={H * 0.52}
            fill="rgba(124,58,237,0.10)" cornerRadius={10} />
          <Rect x={W * 0.08} y={H * 0.68} width={W * 0.62} height={Math.max(H * 0.07, 14)}
            fill="rgba(124,58,237,0.12)" cornerRadius={7} />
          <Rect x={W * 0.08} y={H * 0.79} width={W * 0.42} height={Math.max(H * 0.055, 11)}
            fill="rgba(124,58,237,0.08)" cornerRadius={6} />
        </>
      )}

      {/* 扫光 shimmer(对角高光带,循环) */}
      <Rect
        x={bandX} y={-H * 0.2}
        width={bandW} height={H * 1.4}
        rotation={12}
        fillLinearGradientStartPoint={{ x: 0, y: 0 }}
        fillLinearGradientEndPoint={{ x: bandW, y: 0 }}
        fillLinearGradientColorStops={[
          0, 'rgba(255,255,255,0)',
          0.5, srcImg ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.5)',
          1, 'rgba(255,255,255,0)',
        ]}
        listening={false}
      />

      {/* 呼吸边框 */}
      <Rect width={W} height={H} cornerRadius={8}
        stroke={isSelected ? '#7c3aed' : `rgba(124,58,237,${breath.toFixed(3)})`}
        strokeWidth={isSelected ? 2.5 : 2} listening={false} />

      {/* 顶部 label + 已耗时 */}
      <Rect x={12} y={12} width={Math.min(W - 24, 380)} height={26}
        fill={srcImg ? 'rgba(20,14,46,0.72)' : 'rgba(255,255,255,0.9)'} cornerRadius={13} />
      <Text x={20} y={19} width={Math.min(W - 40, 368)}
        text={`${obj.label}${elapsedText}`}
        fontSize={12} fontStyle="500"
        fill={srcImg ? '#d8ccff' : accent} ellipsis wrap="none" />

      {/* 底部状态行 */}
      <Text x={20} y={H - 26} width={W - 40}
        text="生成中 · 切走也不会丢,完成后自动出现在这里"
        fontSize={11}
        fill={srcImg ? 'rgba(255,255,255,0.66)' : 'rgba(0,0,0,0.45)'}
        align="center" />
    </Group>
  )
}
