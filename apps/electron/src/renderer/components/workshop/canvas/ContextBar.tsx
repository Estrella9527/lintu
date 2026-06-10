import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  Eraser, Expand, Loader2, Maximize, Paintbrush,
  Sparkles, Type, Wand2,
} from 'lucide-react'

import { activeProjectIdAtom } from '@/atoms/project'
import { maskModeAtom, outpaintModeAtom } from '@/atoms/canvas'
import {
  generateOnCanvas, type GenerationCandidate, type GenerationType,
} from '@/lib/canvasGenerate'
import { cn } from '@/lib/utils'

import { AskAIPopover } from './AskAIPopover'
import { CandidateGrid } from './CandidateGrid'

interface ContextBarProps {
  /** 选中的 image_id(后端 ImageRecord.id) */
  imageId: string
  /** 选中对象的客户端 canvas object id(用于 maskMode / outpaintMode 标识) */
  objectId: string
  /** 选中对象在画布坐标系里的 bounds — outpaint 8 手柄初始化要用 */
  objBounds: { x: number; y: number; width: number; height: number }
  /** 屏幕坐标(像素),由 CanvasMode 用 viewport 算好 */
  anchor: { x: number; y: number; width: number; height: number }
  containerHeight: number
  /** 用户挑了候选后的回调 — 由 CanvasMode 决定是 add 还是 replace */
  onApplyCandidate: (
    cand: GenerationCandidate,
    action: 'replace' | 'add',
    sourceImageId: string,
  ) => void
}

type OpKey =
  | 'ask' | 'outpaint' | 'inpaint' | 'matting'
  | 'eraser' | 'upscale' | 'text-zh'

const OPS: Array<{
  key: OpKey
  label: string
  desc: string
  icon: typeof Wand2
  // Phase 1 哪些操作真跑(true) / 哪些占位(false)
  phase1Ready: boolean
  // 后端 GenerationType(不一定跟 key 同名)
  gtype?: GenerationType
}> = [
  { key: 'outpaint', label: '任意扩图', desc: '把画面外扩到任意宽高,原图区域像素保真', icon: Expand,    phase1Ready: true, gtype: 'outpaint' },
  { key: 'inpaint',  label: '局部重绘', desc: '涂抹区域 → 仅对该区域重绘',                icon: Paintbrush, phase1Ready: true, gtype: 'inpaint' },
  { key: 'matting',  label: '抠图',     desc: '抠取主体 / 去除背景',                     icon: Wand2,      phase1Ready: true, gtype: 'matting' },
  { key: 'eraser',   label: '智能消除', desc: '擦除游客 / 杂物,自然补背景',              icon: Eraser,     phase1Ready: true, gtype: 'eraser' },
  { key: 'upscale',  label: '超分增强', desc: '放大并修复细节',                          icon: Maximize,   phase1Ready: true, gtype: 'upscale' },
  { key: 'text-zh',  label: '中文文字', desc: '叠加中文文案',                            icon: Type,       phase1Ready: true, gtype: 'text-zh' },
]

/**
 * 选中图片后浮出的上下文 AI 操作栏 — PRD §3.2 核心入口。
 *
 * 视觉(参考 PRD 图二):一条横向 pill,左侧渐变 Ask AI 主入口,右侧一排
 * ghost 图标按钮。**视觉风格按 lintu 设计语言落地**,不照搬参考图的多彩。
 *
 * 定位由 CanvasMode 计算 DOM 坐标传进来(anchor.x/y/width/height);
 * 当下方剩余空间 < 60px 时翻转到选中图上方。
 *
 * 行为:
 *   - 占位操作(inpaint / eraser / outpaint) → toast "下个版本"
 *     (outpaint 由 PR-6 通过 onStartOutpaint 回调接入 8 手柄交互态)
 *   - 真操作(matting / upscale / text-zh / Ask AI):loading → 候选弹层
 */
export function ContextBar({
  imageId, objectId, objBounds, anchor, containerHeight, onApplyCandidate,
}: ContextBarProps) {
  const projectId = useAtomValue(activeProjectIdAtom)
  const setMaskMode = useSetAtom(maskModeAtom)
  const setOutpaintMode = useSetAtom(outpaintModeAtom)
  const [busyOp, setBusyOp] = useState<OpKey | 'ask' | null>(null)
  const [askOpen, setAskOpen] = useState(false)
  const [candidates, setCandidates] = useState<GenerationCandidate[] | null>(null)
  const [lastOpLabel, setLastOpLabel] = useState('')
  const [lastCost, setLastCost] = useState<number | undefined>()

  // 自动翻转:下方空间不足时贴到上方;预留 8px 间距 + 56px 自身高度(含 padding)
  const BAR_HEIGHT = 56
  const GAP = 8
  const placeBelow = anchor.y + anchor.height + GAP + BAR_HEIGHT < containerHeight
  const top = placeBelow
    ? anchor.y + anchor.height + GAP
    : anchor.y - GAP - BAR_HEIGHT
  // 水平居中到选中图的中点
  const centerX = anchor.x + anchor.width / 2

  const runOp = async (op: OpKey, opLabel: string) => {
    if (!projectId) {
      toast.error('请先选择一个项目')
      return
    }
    setBusyOp(op)
    const res = await generateOnCanvas({
      type: op as GenerationType,
      project_id: projectId,
      input_image_id: imageId,
      count: 2,  // matting/upscale/text-zh:2 张已够选,省时省钱
    })
    setBusyOp(null)
    if (!res.ok) {
      toast.error(`${opLabel} 失败:${res.error.message.slice(0, 120)}`)
      return
    }
    setCandidates(res.candidates)
    setLastOpLabel(opLabel)
    setLastCost(res.total_cost_usd)
  }

  const runAskAI = async (instruction: string) => {
    if (!projectId) {
      toast.error('请先选择一个项目')
      return
    }
    setBusyOp('ask')
    const res = await generateOnCanvas({
      type: 'edit',
      project_id: projectId,
      input_image_id: imageId,
      instruction,
      count: 3,
    })
    setBusyOp(null)
    if (!res.ok) {
      toast.error(`Ask AI 失败:${res.error.message.slice(0, 120)}`)
      return
    }
    setAskOpen(false)
    setCandidates(res.candidates)
    setLastOpLabel(`Ask AI · "${instruction.slice(0, 24)}${instruction.length > 24 ? '…' : ''}"`)
    setLastCost(res.total_cost_usd)
  }

  return (
    <>
      <div
        className="pointer-events-none absolute z-20"
        style={{ top, left: centerX, transform: 'translateX(-50%)' }}
      >
        <div
          className="pointer-events-auto flex flex-nowrap items-center gap-1 whitespace-nowrap
                     rounded-full border border-foreground/8
                     bg-background/98 backdrop-blur-md
                     pl-1.5 pr-2 py-1.5
                     shadow-[0_4px_16px_rgba(0,0,0,0.06)]
                     max-w-[calc(100vw-40px)]"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          // 双指滚动 / 滚轮经过工具栏时,把事件转发给画布 —— 否则平移/缩放手势会
          // 在碰到工具栏边缘的瞬间被吃掉而中断(用户反馈)。转发后画布手势连续。
          onWheel={(e) => {
            const content = document.querySelector('.konvajs-content') as HTMLElement | null
            if (!content) return
            e.preventDefault()
            content.dispatchEvent(new WheelEvent('wheel', {
              deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
              clientX: e.clientX, clientY: e.clientY,
              ctrlKey: e.ctrlKey, metaKey: e.metaKey,
              shiftKey: e.shiftKey, altKey: e.altKey,
              bubbles: true, cancelable: true,
            }))
          }}
        >
          {/* Ask AI 主入口 — 立体粉紫渐变(参考图 Kree8 风格) */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setAskOpen((v) => !v)
            }}
            disabled={busyOp !== null}
            className={cn(
              'relative isolate flex items-center gap-1.5 rounded-full px-3.5 py-1.5',
              'text-[12px] font-semibold text-white',
              'transition-[transform,filter] active:scale-[0.97]',
              'hover:brightness-105 disabled:opacity-55 disabled:cursor-not-allowed',
            )}
            style={{
              // 主背景:左下粉 → 中部紫 → 右上淡黄(暖色高光),
              // 模拟 3D 球面光照感。多个 radial-gradient 叠加。
              background: [
                'radial-gradient(120% 90% at 18% 110%, rgba(255, 145, 200, 0.95) 0%, rgba(255, 145, 200, 0) 60%)',
                'radial-gradient(120% 110% at 80% -10%, rgba(255, 230, 170, 0.85) 0%, rgba(255, 230, 170, 0) 55%)',
                'radial-gradient(140% 140% at 50% 50%, #b88aff 0%, #8862e8 100%)',
              ].join(', '),
              // 外发光 + 浅紫色 ring + 内白色 highlight = 立体感
              boxShadow: [
                '0 6px 16px -4px rgba(138, 92, 245, 0.55)',         // 外阴影
                '0 2px 6px -1px rgba(138, 92, 245, 0.35)',          // 紧贴阴影
                'inset 0 1px 0 0 rgba(255, 255, 255, 0.45)',         // 顶部白色高光
                'inset 0 -1px 0 0 rgba(0, 0, 0, 0.08)',              // 底部微暗
              ].join(', '),
            }}
            title="用自然语言改图(Ask AI)"
          >
            {busyOp === 'ask'
              ? <Loader2 size={12} className="animate-spin drop-shadow-sm" />
              : <Sparkles size={12} strokeWidth={2.2} className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]" />}
            <span className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.15)]">Ask AI</span>
          </button>

          <div className="w-px h-5 bg-foreground/10 mx-0.5" />

          {OPS.map((op) => {
            const Icon = op.icon
            const isBusy = busyOp === op.key
            const disabled = busyOp !== null && !isBusy
            return (
              <button
                key={op.key}
                onClick={(e) => {
                  e.stopPropagation()
                  if (op.key === 'outpaint') {
                    // v0.3 PR-10:进入 8 手柄模式,CanvasStage 切到 OutpaintOverlay
                    setOutpaintMode({
                      objectId,
                      targetX: objBounds.x, targetY: objBounds.y,
                      targetW: objBounds.width, targetH: objBounds.height,
                    })
                    return
                  }
                  if (op.key === 'inpaint' || op.key === 'eraser') {
                    // v0.3 PR-9:进入画笔模式,CanvasStage 切到 MaskBrush + MaskToolbar
                    setMaskMode({ type: op.key, objectId })
                    return
                  }
                  if (op.gtype) void runOp(op.key as OpKey & GenerationType, op.label)
                }}
                disabled={disabled}
                className={cn(
                  'h-7 shrink-0 inline-flex items-center justify-center gap-1 rounded-md px-2',
                  'text-[11.5px] text-foreground/70 transition-colors whitespace-nowrap',
                  'hover:bg-foreground/[0.06] hover:text-foreground',
                  disabled && 'opacity-40 cursor-not-allowed',
                  !op.phase1Ready && op.key !== 'outpaint' && 'opacity-60',
                )}
                title={op.key === 'outpaint' ? `${op.label} · ${op.desc}` :
                       (op.phase1Ready ? `${op.label} · ${op.desc}` : `${op.label}(下个版本)· ${op.desc}`)}
              >
                {isBusy
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Icon size={12} strokeWidth={1.6} />}
                <span>{op.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <AskAIPopover
        open={askOpen}
        anchor={{
          x: centerX - 170,
          y: placeBelow ? top + BAR_HEIGHT + 4 : top - 180,
        }}
        busy={busyOp === 'ask'}
        onClose={() => { if (busyOp !== 'ask') setAskOpen(false) }}
        onSubmit={(instr) => { void runAskAI(instr) }}
      />

      <CandidateGrid
        open={!!candidates}
        onClose={() => setCandidates(null)}
        candidates={candidates || []}
        opLabel={lastOpLabel}
        costUsd={lastCost}
        onApply={(cand, action) => {
          onApplyCandidate(cand, action, imageId)
          setCandidates(null)
        }}
      />
    </>
  )
}
