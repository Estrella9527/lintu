import { useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUp, Check, ChevronDown, ImagePlus, Layers, Loader2, Palette,
  Plus, Settings2, Sparkles, Wand2, X, Zap,
} from 'lucide-react'

import { activeProjectIdAtom } from '@/atoms/project'
import {
  canvasObjectsAtom, canvasParamsAtom, canvasStageSizeAtom, canvasViewportAtom,
  isImageObject, promptBarPromptAtom, promptBarRefsAtom,
  selectedObjectIdAtom,
  type CanvasImageObject, type CanvasPlaceholderObject,
} from '@/atoms/canvas'
import { api, apiFetchRaw } from '@/lib/api'
import { generateOnCanvas, type GenerationCandidate } from '@/lib/canvasGenerate'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useUploadImages } from '@/hooks/useUploadImages'
import { useImageDropPaste } from '@/hooks/useImageDropPaste'
import { cn } from '@/lib/utils'
import type { ImageRecord } from '@/lib/types'

import { CandidateGrid } from './CandidateGrid'
import { StyleArchivePicker } from '@/components/workshop/StyleArchivePicker'

interface ProviderEntry {
  id: string
  name: string
  model?: string
  kind: 'builtin' | 'relay'
}

const RATIOS: Array<{ label: string; w: number; h: number }> = [
  { label: '1:1',   w: 1024, h: 1024 },
  { label: '3:4',   w: 1536, h: 2048 },
  { label: '4:3',   w: 2048, h: 1536 },
  { label: '16:9',  w: 2048, h: 1152 },
  { label: '9:16',  w: 1152, h: 2048 },
  { label: '自定义', w: 0, h: 0 },
]

const SPEEDS: Array<{ value: 'draft' | 'refined'; label: string; hint: string }> = [
  { value: 'draft',   label: '草稿', hint: '低成本探索 · 适合大量出图筛选' },
  { value: 'refined', label: '精修', hint: '高质量出图 · 适合最终交付' },
]

const COUNTS = [1, 2, 3, 4]

/**
 * PR-13 重做版 PromptBar — Lovart 风格大输入框,所有配置内置。
 *
 * 核心交互:
 *   - **模式自动判断**:有 refs(用户上传的参考图) 或 画布选中图 → img2img,否则 → text2img
 *     不再有显式的 文生图 / 图生图 tabs。Agent 模式作为单独 chip 灰显(v0.4)
 *   - 输入框接受拖入 / 粘贴参考图(走 useUploadImages → /images/upload)
 *   - 顶部缩略条:参考图 + 「+」 添加按钮(从本地选)
 *   - 底部 chip 行:Agent 模式(灰) / 模型 / 比例 / 速度 / 数量 / 风格档案,每个点开 Popover 配
 *   - 右下圆形发送按钮(深色背景 + 上箭头)
 */
export function PromptBar() {
  const projectId = useAtomValue(activeProjectIdAtom)
  const setObjects = useSetAtom(canvasObjectsAtom)
  const [selectedId, setSelectedId] = useAtom(selectedObjectIdAtom)
  const objects = useAtomValue(canvasObjectsAtom)
  const setCanvasParams = useSetAtom(canvasParamsAtom)
  const viewport = useAtomValue(canvasViewportAtom)
  const stageSize = useAtomValue(canvasStageSizeAtom)
  const setViewport = useSetAtom(canvasViewportAtom)
  const queryClient = useQueryClient()

  // 用户在 PromptBar 输入框区上传的参考图(此次生成的图生图源)
  // 升到 atom 以便切项目时持久化(见 useCanvasPersistence)
  const [refs, setRefs] = useAtom(promptBarRefsAtom)
  const [prompt, setPrompt] = useAtom(promptBarPromptAtom)
  const [ratio, setRatio] = useState(RATIOS[0])
  const [customW, setCustomW] = useState(2048)
  const [customH, setCustomH] = useState(1024)
  const [speed, setSpeed] = useState<'draft' | 'refined'>('refined')
  const [count, setCount] = useState(1)
  const [styleArchiveId, setStyleArchiveId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [candidates, setCandidates] = useState<GenerationCandidate[] | null>(null)
  const [lastCost, setLastCost] = useState<number | undefined>()

  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 计算最终 W/H — "自定义" 时用 customW/H,否则用 ratio 内置值
  const isCustom = ratio.label === '自定义'
  const effW = isCustom ? customW : ratio.w
  const effH = isCustom ? customH : ratio.h

  // 拉 provider 列表
  const { data: providers } = useQuery<ProviderEntry[]>({
    queryKey: ['providers-available'],
    queryFn: async () => {
      const r = await apiFetchRaw('/providers/available')
      if (!r.ok) return []
      const json = await r.json()
      return Array.isArray(json) ? json : []
    },
  })
  const providerList: ProviderEntry[] = Array.isArray(providers) ? providers : []
  const currentModelLabel = useMemo(() => {
    if (!modelId) return '默认'
    const p = providerList.find((x) => x.id === modelId)
    return p ? (p.model ? `${p.name}` : p.name) : '默认'
  }, [modelId, providerList])

  // selectedObj 只承认 image(不含 placeholder)
  const _selectedRaw = objects.find((o) => o.id === selectedId) || null
  const selectedObj = _selectedRaw && isImageObject(_selectedRaw) ? _selectedRaw : null

  // ── 自动判断模式 ──────────────────────────────────────────────────
  // 用户上传了参考图 || 选中了画布对象 → 图生图;否则文生图
  // 决定 input_image_id 来源:refs 优先,fallback 到 selectedObj
  const effectiveMode: 'text2img' | 'img2img' =
    (refs.length > 0 || !!selectedObj) ? 'img2img' : 'text2img'
  const inputImageId = refs[0]?.id || selectedObj?.image_id || undefined

  // ── 同步参数到 atom ───────────────────────────────────────────────
  useEffect(() => {
    setCanvasParams({
      mode: effectiveMode, prompt,
      target_w: effW, target_h: effH,
      ratio_label: isCustom ? `自定义 ${effW}×${effH}` : ratio.label,
      speed, count,
      style_archive_id: styleArchiveId,
    })
  }, [effectiveMode, prompt, effW, effH, ratio.label, isCustom, speed, count, styleArchiveId, setCanvasParams])

  // ── 上传参考图(拖拽 / 粘贴 / 点 + 选本地) ─────────────────────────
  const { upload, uploading } = useUploadImages({
    projectId,
    onSuccess: ({ images, duplicate_images }) => {
      const all = [...images, ...duplicate_images]
      if (!all.length) return
      // 把新上传的图加入 refs(避免重复)
      setRefs((prev) => {
        const seen = new Set(prev.map((r) => r.id))
        return [...prev, ...all.filter((i) => !seen.has(i.id))]
      })
      queryClient.invalidateQueries({ queryKey: ['images', projectId] })
    },
  })
  // 输入框区只接「拖拽」,不接全局粘贴。
  // 全局 paste 由 CanvasStage 独占 — 否则贴一张图会同时触发 PromptBar + CanvasStage
  // 两个 document 级监听,导致重复上传 / 状态错乱(2026-06 实测 bug)。
  // 拖拽是局部 ref,两边互不干扰,可各自保留。
  useImageDropPaste({
    dropRef: containerRef,
    enabled: !!projectId,
    enablePaste: false,
    onFiles: (files) => { void upload(files) },
  })

  // ── 发送(fire-and-forget + 占位图)─────────────────────────────────
  // 关键改造:不再 await 整个 promise。点生成立刻在画布上 push 一个 placeholder,
  // 之后 fetch 异步完成时按 placeholderId 找回并替换。这样:
  //   - 用户点其他地方 / 切走再回来,任务不会断
  //   - 多次连发也能并行 — 每次一个 placeholder,各自独立
  //   - 失败时 placeholder 转 error 态,带 errorMessage 可见
  const handleSubmit = () => {
    if (!projectId) { toast.error('请先选择一个项目'); return }
    if (!prompt.trim()) { toast.error('请输入提示词'); return }
    if (isCustom && (effW < 256 || effH < 256 || effW > 4096 || effH > 4096)) {
      toast.error('自定义尺寸:宽高需在 256 - 4096 之间')
      return
    }

    // 位置:画布视口中心 → 世界坐标。canvasStageSizeAtom 由 CanvasStage 维护,
    // 比 document.querySelector('canvas') 可靠(Konva 有多个 canvas 元素)
    const canvasW = stageSize.w || 1200
    const canvasH = stageSize.h || 800
    const centerX = (canvasW / 2 - viewport.x) / viewport.scale
    const centerY = (canvasH / 2 - viewport.y) / viewport.scale
    const stagger = (objects.length % 4) * 32
    const placeholderId = `co_ph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const placeholder: CanvasPlaceholderObject = {
      type: 'placeholder',
      id: placeholderId,
      status: 'pending',
      label: `${effectiveMode === 'text2img' ? '文生图' : '图生图'} · ${prompt.trim().slice(0, 28)}${prompt.trim().length > 28 ? '…' : ''}`,
      requestType: effectiveMode,
      x: centerX - effW / 2 + stagger,
      y: centerY - effH / 2 + stagger,
      width: effW,
      height: effH,
      rotation: 0,
      selected: false,
    }
    setObjects((prev) => [...prev, placeholder])
    setSelectedId(placeholderId)

    const submittedPrompt = prompt.trim()  // 锁住当时值,后面清空 prompt 不影响请求
    const submittedRefs = refs              // 同
    setBusy(true)

    // fire-and-forget — 不 await
    ;(async () => {
      const res = await generateOnCanvas({
        type: effectiveMode,
        project_id: projectId,
        prompt: submittedPrompt,
        input_image_id: effectiveMode === 'img2img'
          ? (submittedRefs[0]?.id || selectedObj?.image_id || undefined)
          : undefined,
        target_w: effW,
        target_h: effH,
        speed,
        count,
        style_archive_id: styleArchiveId || undefined,
        model_id: modelId || undefined,
      })
      setBusy(false)
      if (!res.ok) {
        // placeholder 转 error,保留可见
        setObjects((prev) => prev.map((o) =>
          o.id === placeholderId
            ? { ...(o as CanvasPlaceholderObject), status: 'error' as const, errorMessage: res.error.message }
            : o,
        ))
        toast.error(`生成失败:${res.error.message.slice(0, 120)}`)
        return
      }
      const first = res.candidates[0]
      if (!first) {
        setObjects((prev) => prev.filter((o) => o.id !== placeholderId))
        toast.error('未返回任何候选图')
        return
      }
      // 用第一张候选替换 placeholder,以 placeholder 中心点为锚定居中
      // (模型可能返回比 target 略小/略大的尺寸,以中心为基准重新算 x/y 避免视觉跳动)
      setObjects((prev) => prev.map((o) => {
        if (o.id !== placeholderId) return o
        const cx = o.x + o.width / 2
        const cy = o.y + o.height / 2
        const nw = first.w || o.width
        const nh = first.h || o.height
        return {
          type: 'image',
          id: placeholderId,  // 复用 id,选中状态延续
          image_id: first.image_id,
          src: api.images.fileUrl(first.image_id),
          x: cx - nw / 2,
          y: cy - nh / 2,
          width: nw,
          height: nh,
          rotation: 0,
          selected: false,
        } as CanvasImageObject
      }))
      setLastCost(res.total_cost_usd)
      // 多张候选:打开 picker 让用户选别的
      if (res.candidates.length > 1) {
        setCandidates(res.candidates)
      }
    })()
  }

  const handleApply = (cand: GenerationCandidate, action: 'replace' | 'add') => {
    const baseX = selectedObj ? selectedObj.x + 60 : 100
    const baseY = selectedObj ? selectedObj.y + 60 : 100
    const newObj: CanvasImageObject = {
      type: 'image',
      id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      image_id: cand.image_id,
      src: api.images.fileUrl(cand.image_id),
      x: action === 'replace' && selectedObj ? selectedObj.x : baseX,
      y: action === 'replace' && selectedObj ? selectedObj.y : baseY,
      width: cand.w, height: cand.h, rotation: 0, selected: false,
    }
    setObjects((prev) => {
      if (action === 'replace' && selectedObj) {
        return prev.map((o) => (o.id === selectedObj.id ? newObj : o))
      }
      return [...prev, newObj]
    })
    setSelectedId(newObj.id)
    setCandidates(null)
  }

  // ── UI ───────────────────────────────────────────────────────────
  return (
    <>
      <div className="px-4 pt-2 pb-3">
        <div
          ref={containerRef}
          className="rounded-2xl border border-foreground/12 bg-background
                     shadow-[0_2px_12px_rgba(0,0,0,0.04)]
                     focus-within:border-foreground/25 focus-within:shadow-[0_2px_16px_rgba(0,0,0,0.06)]
                     transition-shadow"
        >
          {/* ── 顶部:refs 缩略行(有图或上传中显示) ─────────────────── */}
          {(refs.length > 0 || uploading) && (
            <div className="flex items-center gap-2 px-3 pt-3 pb-1 flex-wrap">
              {refs.map((r) => (
                <RefThumb
                  key={r.id}
                  image={r}
                  onRemove={() => setRefs((prev) => prev.filter((x) => x.id !== r.id))}
                />
              ))}
              {/* 「+」 添加按钮:出现在缩略后面,鼓励继续加 */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !projectId}
                className="h-14 w-14 rounded-lg border border-dashed border-foreground/15
                           bg-foreground/[0.02] hover:bg-foreground/[0.04]
                           inline-flex items-center justify-center text-foreground/40
                           hover:text-foreground/60 transition-colors"
                title="再加一张参考图"
              >
                {uploading
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Plus size={14} strokeWidth={1.5} />}
              </button>
            </div>
          )}

          {/* ── 输入框 ────────────────────────────────────────────── */}
          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                if (!busy) void handleSubmit()
              }
            }}
            placeholder={
              effectiveMode === 'text2img'
                ? '输入想法描述,或拖入 / 粘贴参考图(Cmd+Enter 提交)'
                : refs.length > 0
                  ? `描述如何改这 ${refs.length} 张图(Cmd+Enter 提交)`
                  : '描述如何改画布选中的图(Cmd+Enter 提交)'
            }
            className="border-0 shadow-none resize-none px-3 py-3 text-[13px] min-h-[64px] max-h-[200px]
                       focus-visible:ring-0 focus-visible:outline-none bg-transparent"
            disabled={busy}
          />

          {/* ── 底部 chip 行 + 发送 ─────────────────────────────────── */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1 flex-wrap">
            {/* Agent 模式 — 用「即将上线」Badge 取代灰 disabled chip,
                避免和"模型/比例不可用时的灰显"混淆,让用户明确这是规划功能而非故障。 */}
            <span
              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/8
                         px-2 py-[3px] text-[11px] text-accent/80 select-none cursor-default"
              title="智能体编排 · v0.4 开放"
            >
              <Wand2 size={11} strokeWidth={1.6} />
              Agent 模式
              <span className="ml-0.5 rounded-sm bg-accent/15 px-1 text-[9.5px] leading-[14px] text-accent/90">
                即将上线
              </span>
            </span>

            {/* 模型 */}
            <PopoverChip
              icon={<Settings2 size={11} strokeWidth={1.6} />}
              label={`模型 · ${currentModelLabel}`}
              tooltip="切换底层模型"
            >
              <div className="space-y-1 max-h-[280px] overflow-y-auto">
                <ModelOption
                  selected={modelId === ''}
                  onClick={() => setModelId('')}
                  title="默认"
                  hint="跟随项目 default_image_provider 配置"
                />
                {providerList.map((p) => (
                  <ModelOption
                    key={p.id}
                    selected={modelId === p.id}
                    onClick={() => setModelId(p.id)}
                    title={p.name}
                    hint={p.model || p.kind}
                  />
                ))}
                {providerList.length === 0 && (
                  <div className="text-[11px] text-foreground/40 px-2 py-3 text-center">
                    没有可用 provider,去 设置 → AI 服务商 配置
                  </div>
                )}
              </div>
            </PopoverChip>

            {/* 比例 */}
            <PopoverChip
              icon={<Layers size={11} strokeWidth={1.6} />}
              label={isCustom ? `${effW}×${effH}` : ratio.label}
              tooltip="输出比例"
            >
              <div className="space-y-1">
                {RATIOS.map((r) => (
                  <button
                    key={r.label}
                    onClick={() => setRatio(r)}
                    className={cn(
                      'w-full flex items-center justify-between px-2 py-1.5 rounded-md',
                      'text-[12px] transition-colors',
                      ratio.label === r.label
                        ? 'bg-accent/10 text-accent'
                        : 'text-foreground/70 hover:bg-foreground/[0.05]',
                    )}
                  >
                    <span>{r.label}</span>
                    {r.label !== '自定义' && (
                      <span className="text-[10.5px] text-foreground/40 tabular-nums">
                        {r.w}×{r.h}
                      </span>
                    )}
                    {ratio.label === r.label && <Check size={11} />}
                  </button>
                ))}
                {isCustom && (
                  <div className="pt-2 mt-2 border-t border-foreground/8 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-foreground/55 w-8">宽</label>
                      <Input type="number" min={256} max={4096}
                        value={customW}
                        onChange={(e) => setCustomW(Number(e.target.value) || 1024)}
                        className="h-7 text-[12px] tabular-nums" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-foreground/55 w-8">高</label>
                      <Input type="number" min={256} max={4096}
                        value={customH}
                        onChange={(e) => setCustomH(Number(e.target.value) || 1024)}
                        className="h-7 text-[12px] tabular-nums" />
                    </div>
                  </div>
                )}
              </div>
            </PopoverChip>

            {/* 速度 */}
            <PopoverChip
              icon={<Zap size={11} strokeWidth={1.6} />}
              label={SPEEDS.find((s) => s.value === speed)?.label || '精修'}
              tooltip="生成速度 / 质量档"
            >
              <div className="space-y-1">
                {SPEEDS.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setSpeed(s.value)}
                    className={cn(
                      'w-full flex items-start justify-between gap-2 px-2 py-1.5 rounded-md text-left',
                      'transition-colors',
                      speed === s.value
                        ? 'bg-accent/10 text-accent'
                        : 'text-foreground/70 hover:bg-foreground/[0.05]',
                    )}
                  >
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium">{s.label}</div>
                      <div className="text-[10.5px] text-foreground/45 mt-0.5">{s.hint}</div>
                    </div>
                    {speed === s.value && <Check size={11} className="mt-1" />}
                  </button>
                ))}
              </div>
            </PopoverChip>

            {/* 数量 */}
            <PopoverChip
              icon={<Sparkles size={11} strokeWidth={1.6} />}
              label={`×${count}`}
              tooltip="一次生成的候选数量"
            >
              <div className="grid grid-cols-4 gap-1.5">
                {COUNTS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setCount(c)}
                    className={cn(
                      'h-8 rounded-md text-[12.5px] tabular-nums transition-colors',
                      count === c
                        ? 'bg-accent text-white'
                        : 'bg-foreground/[0.04] text-foreground/70 hover:bg-foreground/[0.08]',
                    )}
                  >
                    ×{c}
                  </button>
                ))}
              </div>
            </PopoverChip>

            {/* 风格档案 */}
            <PopoverChip
              icon={<Palette size={11} strokeWidth={1.6} />}
              label="风格"
              tooltip="应用风格档案 — 保证跨图一致"
            >
              <div className="min-w-[240px]">
                <StyleArchivePicker
                  value={styleArchiveId}
                  onChange={setStyleArchiveId}
                  showLabel={false}
                />
                <div className="text-[10.5px] text-foreground/45 mt-2">
                  没有档案?去 设置 → 风格档案 新建
                </div>
              </div>
            </PopoverChip>

            {/* 模式 hint(自动判断,不可点) */}
            <span className="text-[10.5px] text-foreground/35 ml-1 inline-flex items-center gap-1">
              {effectiveMode === 'img2img'
                ? <><ImagePlus size={10} /> 图生图(自动)</>
                : <><Sparkles size={10} /> 文生图(自动)</>}
            </span>

            {/* 发送按钮(右下 圆形) */}
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={busy || !prompt.trim() || !projectId}
              className={cn(
                'ml-auto h-9 w-9 rounded-full inline-flex items-center justify-center',
                'transition-all',
                busy || !prompt.trim() || !projectId
                  ? 'bg-foreground/15 text-foreground/40 cursor-not-allowed'
                  : 'bg-foreground text-background hover:opacity-85 active:scale-95',
              )}
              title="生成 (Cmd+Enter)"
            >
              {busy
                ? <Loader2 size={15} className="animate-spin" />
                : <ArrowUp size={15} strokeWidth={2} />}
            </button>
          </div>

          {/* 隐式 file input — 「+」按钮触发 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || [])
              if (files.length) void upload(files)
              if (fileInputRef.current) fileInputRef.current.value = ''
            }}
          />
        </div>
      </div>

      <CandidateGrid
        open={!!candidates}
        onClose={() => setCandidates(null)}
        candidates={candidates || []}
        opLabel={effectiveMode === 'text2img' ? '文生图' : '图生图'}
        costUsd={lastCost}
        canReplace={effectiveMode === 'img2img' && !!selectedObj}
        onApply={handleApply}
      />
    </>
  )
}

// ─── 子组件 ──────────────────────────────────────────────────────────

/** 通用 Chip 按钮 — 灰白底,hover 加深;disabled 时 50% 透明。 */
function Chip({ icon, label, disabled, tooltip, onClick }: {
  icon: React.ReactNode
  label: string
  disabled?: boolean
  tooltip?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      disabled={disabled}
      className={cn(
        'h-7 inline-flex items-center gap-1.5 px-2.5 rounded-md',
        'text-[11.5px] text-foreground/70 transition-colors',
        'border border-foreground/10 bg-foreground/[0.015]',
        disabled
          ? 'opacity-45 cursor-not-allowed'
          : 'hover:bg-foreground/[0.05] hover:text-foreground hover:border-foreground/18',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

/** Popover 包装的 Chip — 点开展开 panel。 */
function PopoverChip({
  icon, label, tooltip, children,
}: {
  icon: React.ReactNode
  label: string
  tooltip?: string
  children: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          className={cn(
            'h-7 inline-flex items-center gap-1.5 px-2.5 rounded-md',
            'text-[11.5px] text-foreground/70 transition-colors',
            'border border-foreground/10 bg-foreground/[0.015]',
            'hover:bg-foreground/[0.05] hover:text-foreground hover:border-foreground/18',
            'data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground data-[state=open]:border-foreground/20',
          )}
        >
          {icon}
          <span>{label}</span>
          <ChevronDown size={10} className="text-foreground/45" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[260px] p-2">
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** 单个模型选项 — 在模型 PopoverChip 里用。 */
function ModelOption({ selected, onClick, title, hint }: {
  selected: boolean
  onClick: () => void
  title: string
  hint?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-start justify-between gap-2 px-2 py-1.5 rounded-md text-left',
        'transition-colors',
        selected ? 'bg-accent/10 text-accent' : 'text-foreground/70 hover:bg-foreground/[0.05]',
      )}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium truncate">{title}</div>
        {hint && <div className="text-[10.5px] text-foreground/45 truncate mt-0.5">{hint}</div>}
      </div>
      {selected && <Check size={11} className="mt-1 shrink-0" />}
    </button>
  )
}

/** 参考图缩略 — 顶部行的小卡。 */
function RefThumb({ image, onRemove }: { image: ImageRecord; onRemove: () => void }) {
  return (
    <div className="relative h-14 w-14 rounded-lg overflow-hidden ring-1 ring-foreground/10 bg-foreground/[0.04]
                    group">
      <img
        src={api.images.thumbnailUrl(image.id, 128)}
        alt={image.file_name}
        className="w-full h-full object-cover"
      />
      <button
        onClick={onRemove}
        title="从参考图移除"
        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-background/95
                   text-foreground/65 hover:text-destructive hover:bg-background
                   opacity-0 group-hover:opacity-100 transition-opacity
                   inline-flex items-center justify-center
                   shadow-[0_1px_2px_rgba(0,0,0,0.15)]"
      >
        <X size={9} strokeWidth={2.5} />
      </button>
    </div>
  )
}
