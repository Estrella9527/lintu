import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { Layer, Stage } from 'react-konva'
import type Konva from 'konva'

import { api } from '@/lib/api'
import { activeProjectIdAtom } from '@/atoms/project'
import {
  canvasObjectsAtom,
  canvasStageSizeAtom,
  canvasViewportAtom,
  isImageObject,
  isPlaceholderObject,
  maskModeAtom,
  outpaintModeAtom,
  selectedObjectIdAtom,
  type CanvasImageObject,
  type CanvasObject,
} from '@/atoms/canvas'
import { useImageDropPaste } from '@/hooks/useImageDropPaste'
import { useUploadImages } from '@/hooks/useUploadImages'
import { useCanvasHistory } from '@/hooks/useCanvasHistory'
import { useCanvasPersistence } from '@/hooks/useCanvasPersistence'
import { ImageDropOverlay } from '@/components/shared/ImageDropOverlay'
import { SeedPickerDialog } from '@/components/workshop/SeedPickerDialog'
import { Button } from '@/components/ui/button'
import { FolderOpen } from 'lucide-react'
import type { ImageRecord } from '@/lib/types'

import { CanvasImage } from './CanvasImage'
import { CanvasPlaceholder } from './CanvasPlaceholder'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasEmpty } from './CanvasEmpty'
import { ContextBar } from './ContextBar'
import { MaskBrush, type MaskBrushHandle } from './MaskBrush'
import { MaskToolbar } from './MaskToolbar'
import { OutpaintOverlay } from './OutpaintOverlay'
import { generateOnCanvas, type GenerationCandidate } from '@/lib/canvasGenerate'
import { toast } from 'sonner'
import { CandidateGrid } from './CandidateGrid'

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const SCALE_STEP = 1.08    // 每次滚轮一格 / 触控板捏合的步长

/**
 * 画布主舞台。挂在 CanvasMode 的 body 中,撑满父容器。
 *
 * 职责:
 *   - 维护 viewport (scale + offset),响应滚轮 / 空格+拖拽
 *   - 渲染所有 CanvasObject(目前只有 image 一种)
 *   - 处理选中态(点空白处取消选中)
 *   - 接 useImageDropPaste:拖入 / 粘贴 → 上传到当前项目 → 落到画布中心
 *   - 顶部叠加 CanvasToolbar(缩放百分比 / 复位 / undo / redo)
 *   - 对象数 0 时显示 CanvasEmpty
 *
 * 不在这里做的事:
 *   - ContextBar 浮层 — PR-5 单独写,挂在 CanvasMode 外层
 *   - 任意扩图 8 手柄 — PR-6 通过状态机切到 outpaint 态时显示
 */
export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Konva.Stage>(null)
  const queryClient = useQueryClient()
  const projectId = useAtomValue(activeProjectIdAtom)
  const [objects, setObjects] = useAtom(canvasObjectsAtom)
  const [viewport, setViewport] = useAtom(canvasViewportAtom)
  const [selectedId, setSelectedId] = useAtom(selectedObjectIdAtom)
  const [size, setSizeLocal] = useState({ w: 0, h: 0 })
  const setCanvasStageSize = useSetAtom(canvasStageSizeAtom)
  // local 用 useState 是为了 Konva Stage 受控渲染(同步且高频);atom 同步给别的组件(PromptBar)
  const setSize = (s: { w: number; h: number }) => { setSizeLocal(s); setCanvasStageSize(s) }
  const [spaceDown, setSpaceDown] = useState(false)

  const { push, undo, redo, canUndo, canRedo } = useCanvasHistory()
  // PR-16:画布持久化 — 切项目自动恢复,防抖回写
  const { lastSavedAt, clearCanvas } = useCanvasPersistence()

  // ── 1. 响应容器尺寸变化(window resize / 右面板折叠)─────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── 2. 空格键切到"抓手模式"(panning) ───────────────────────────────
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      e.preventDefault()
      setSpaceDown(true)
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    document.addEventListener('keydown', onDown)
    document.addEventListener('keyup', onUp)
    return () => {
      document.removeEventListener('keydown', onDown)
      document.removeEventListener('keyup', onUp)
    }
  }, [])

  // ── 3. 滚轮 / 触控板:Figma 风格 ─────────────────────────────────
  //   - 滚轮 / 触控板双指滑(无修饰) = 平移画布(Figma 默认)
  //   - Cmd/Ctrl + 滚轮 = 以光标为中心缩放
  //   - 触控板捏合(ctrlKey 由浏览器合成)= 缩放
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    // Mac trackpad 双指捏合时浏览器把 deltaY + ctrlKey=true 合成给我们(即使没按 Ctrl)
    const wantZoom = e.evt.metaKey || e.evt.ctrlKey
    if (wantZoom) {
      const oldScale = stage.scaleX()
      const pointer = stage.getPointerPosition()
      if (!pointer) return
      const mousePoint = {
        x: (pointer.x - stage.x()) / oldScale,
        y: (pointer.y - stage.y()) / oldScale,
      }
      const direction = e.evt.deltaY > 0 ? 1 / SCALE_STEP : SCALE_STEP
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * direction))
      setViewport({
        scale: newScale,
        x: pointer.x - mousePoint.x * newScale,
        y: pointer.y - mousePoint.y * newScale,
      })
    } else {
      // 平移:deltaX / deltaY 直接转 viewport offset
      setViewport((v) => ({
        ...v,
        x: v.x - e.evt.deltaX,
        y: v.y - e.evt.deltaY,
      }))
    }
  }, [setViewport])

  // 键盘缩放:+/= 放大,- 缩小,0 复位,F fit
  // 注意:这部分不能简单调 resetView,resetView 引用未来变量,放到下面统一挂
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      // 缩放快捷键 — 不接 Cmd Z (history hook 已处理)
      if (e.key === '0') {
        // 100% 还原 + 居中所有对象
        e.preventDefault()
        // 触发后面声明的 resetView — 用 window event 解耦
        window.dispatchEvent(new CustomEvent('lintu:canvas:reset-view'))
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        setViewport((v) => ({
          ...v,
          scale: Math.min(MAX_SCALE, v.scale * SCALE_STEP),
        }))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setViewport((v) => ({
          ...v,
          scale: Math.max(MIN_SCALE, v.scale / SCALE_STEP),
        }))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setViewport])

  // 自动 fit 标志 — 第一张图入画布时把视图缩到能 fit;后续操作期间不再
  // 自动 fit(以免用户主动平移 / 缩放被覆盖)。声明在 insertImagesToCanvas
  // 之前是因为后者在 callback 里要写它。
  const fittedRef = useRef(false)

  // ── 4. 拖入 / 粘贴上传 ────────────────────────────────────────────────
  // 把一组 ImageRecord 插入画布,以原图分辨率渲染。资产库选图 + 上传成功
  // 都走这个函数,保证两条路径的行为一致(尺寸 / 偏移 / 选中)。
  const insertImagesToCanvas = useCallback((items: ImageRecord[]) => {
    if (!items.length) return
    const stage = stageRef.current
    const centerX = stage ? (stage.width() / 2 - viewport.x) / viewport.scale : 0
    const centerY = stage ? (stage.height() / 2 - viewport.y) / viewport.scale : 0
    const additions: CanvasImageObject[] = items.map((img, idx) => {
      const w = img.width || 1024
      const h = img.height || 1024
      return {
        type: 'image',
        id: `co_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
        image_id: img.id,
        src: api.images.fileUrl(img.id),
        x: centerX - w / 2 + idx * 40,
        y: centerY - h / 2 + idx * 40,
        width: w,
        height: h,
        rotation: 0,
        selected: false,
      }
    })
    push()  // history 在新增对象前快照
    setObjects((prev) => [...prev, ...additions])
    if (additions.length) setSelectedId(additions[additions.length - 1].id)
    // 第一张图落地时自动 fit;后续手动按 toolbar 「复位视图」按钮
    fittedRef.current = false
  }, [viewport.x, viewport.y, viewport.scale, push, setObjects, setSelectedId])

  const { upload } = useUploadImages({
    projectId,
    onSuccess: ({ images, duplicate_images }) => {
      // 新上传和已有同 hash 图都拉到画布(PRD §3.1:"拖入图片到画布 → 进入图生图")
      const all = [...images, ...duplicate_images]
      if (!all.length) return
      queryClient.invalidateQueries({ queryKey: ['images', projectId] })
      insertImagesToCanvas(all)
    },
  })
  const { isDragging } = useImageDropPaste({
    dropRef: containerRef,
    enabled: !!projectId,
    onFiles: (files) => { void upload(files) },
  })

  // 「从资产库选择」 — 复用 SeedPickerDialog
  const [showPicker, setShowPicker] = useState(false)

  // ── PR-9 画笔模式(inpaint / eraser) ───────────────────────────────────
  const [maskMode, setMaskMode] = useAtom(maskModeAtom)
  const [brushSize, setBrushSize] = useState(48)
  const [maskBusy, setMaskBusy] = useState(false)
  const [maskCandidates, setMaskCandidates] = useState<GenerationCandidate[] | null>(null)
  const [maskCost, setMaskCost] = useState<number | undefined>()
  const [maskOpLabel, setMaskOpLabel] = useState('')
  const [maskHasStrokes, setMaskHasStrokes] = useState(false)  // 同步给 MaskToolbar 控制可生成 / 可撤销
  const maskBrushRef = useRef<MaskBrushHandle>(null)

  // maskMode / outpaintMode 必须找到 image object(placeholder 没有 image_id,不能涂)
  const _maskObjRaw = maskMode ? objects.find((o) => o.id === maskMode.objectId) || null : null
  const maskObj = _maskObjRaw && isImageObject(_maskObjRaw) ? _maskObjRaw : null

  // ── PR-10 outpaint 8 手柄模式 ───────────────────────────────────────
  const [outpaintMode, setOutpaintMode] = useAtom(outpaintModeAtom)
  const [outpaintBusy, setOutpaintBusy] = useState(false)
  const [outpaintCandidates, setOutpaintCandidates] = useState<GenerationCandidate[] | null>(null)
  const [outpaintCost, setOutpaintCost] = useState<number | undefined>()
  const [outpaintLabel, setOutpaintLabel] = useState('')
  const _outpaintObjRaw = outpaintMode ? objects.find((o) => o.id === outpaintMode.objectId) || null : null
  const outpaintObj = _outpaintObjRaw && isImageObject(_outpaintObjRaw) ? _outpaintObjRaw : null

  const submitOutpaint = async (params: {
    targetW: number; targetH: number
    alignX: 'left' | 'center' | 'right'
    alignY: 'top'  | 'middle' | 'bottom'
  }) => {
    if (!outpaintObj || !projectId) return
    setOutpaintBusy(true)
    try {
      const res = await generateOnCanvas({
        type: 'outpaint',
        project_id: projectId,
        input_image_id: outpaintObj.image_id,
        target_w: params.targetW,
        target_h: params.targetH,
        align_x: params.alignX,
        align_y: params.alignY,
        count: 2,
      })
      if (!res.ok) {
        toast.error(`任意扩图失败:${res.error.message.slice(0, 120)}`)
        return
      }
      setOutpaintCandidates(res.candidates)
      setOutpaintCost(res.total_cost_usd)
      setOutpaintLabel(`任意扩图 → ${params.targetW}×${params.targetH}`)
    } finally {
      setOutpaintBusy(false)
    }
  }

  const submitMask = async (prompt: string) => {
    if (!maskMode || !maskObj || !projectId || !maskBrushRef.current) return
    if (!maskBrushRef.current.hasStrokes()) {
      toast.error('请先涂抹要修改的区域')
      return
    }
    setMaskBusy(true)
    try {
      const maskB64 = await maskBrushRef.current.exportMask()
      const res = await generateOnCanvas({
        type: maskMode.type,
        project_id: projectId,
        input_image_id: maskObj.image_id,
        mask: maskB64,
        prompt: maskMode.type === 'inpaint' ? prompt : undefined,
        count: 2,
      })
      if (!res.ok) {
        toast.error(`${maskMode.type === 'inpaint' ? '局部重绘' : '智能消除'} 失败:${res.error.message.slice(0, 120)}`)
        return
      }
      setMaskCandidates(res.candidates)
      setMaskCost(res.total_cost_usd)
      setMaskOpLabel(maskMode.type === 'inpaint' ? `局部重绘 · "${prompt.slice(0, 24)}"` : '智能消除')
    } finally {
      setMaskBusy(false)
    }
  }

  // ── 5. 复位视图(scale=1, 平移让所有对象 fit 中心) ──────────────────
  const resetView = useCallback(() => {
    if (objects.length === 0) {
      setViewport({ scale: 1, x: 0, y: 0 })
      return
    }
    // 算所有对象的 bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const o of objects) {
      minX = Math.min(minX, o.x)
      minY = Math.min(minY, o.y)
      maxX = Math.max(maxX, o.x + o.width)
      maxY = Math.max(maxY, o.y + o.height)
    }
    const bw = maxX - minX
    const bh = maxY - minY
    const padding = 80
    const scale = Math.min(
      (size.w - padding * 2) / bw,
      (size.h - padding * 2) / bh,
      1,
    )
    const x = (size.w - bw * scale) / 2 - minX * scale
    const y = (size.h - bh * scale) / 2 - minY * scale
    setViewport({ scale: Math.max(MIN_SCALE, scale), x, y })
  }, [objects, size.w, size.h, setViewport])

  // 第一次有对象时自动 fit(fittedRef 在文件上方已声明)
  useEffect(() => {
    if (!fittedRef.current && objects.length > 0 && size.w > 0) {
      fittedRef.current = true
      resetView()
    }
    if (objects.length === 0) fittedRef.current = false
  }, [objects.length, size.w, resetView])

  // 接键盘 0 触发的 reset-view 事件 — 见上面 onKey 处理
  useEffect(() => {
    const onReset = () => resetView()
    window.addEventListener('lintu:canvas:reset-view', onReset)
    return () => window.removeEventListener('lintu:canvas:reset-view', onReset)
  }, [resetView])

  // Delete / Backspace 键删除选中的画布对象(Figma 一致)
  // 注意:不在 maskMode / outpaintMode 中触发 — 那时候按键可能是其它含义
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // 输入框聚焦时让原生 backspace 删字符,不要误删画布对象
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      if (maskMode || outpaintMode) return
      if (!selectedId) return
      e.preventDefault()
      push()  // history snapshot 在删除前
      setObjects((prev) => prev.filter((o) => o.id !== selectedId))
      setSelectedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectedId, maskMode, outpaintMode, setObjects, setSelectedId, push])

  const updateObject = useCallback((next: CanvasImageObject) => {
    setObjects((prev) => prev.map((o) => (o.id === next.id ? next : o)))
  }, [setObjects])

  // 计算选中对象在屏幕上的 anchor(DOM 坐标系),供 ContextBar 浮层定位。
  // Konva 对象用画布坐标系,要乘以 viewport.scale + 加 viewport.x/y 才是 DOM 像素。
  // 注意:placeholder 没意义的 image_id,所以 ContextBar 只对真 image 显示。
  const _selectedRaw = objects.find((o) => o.id === selectedId) || null
  const selectedObj = _selectedRaw && isImageObject(_selectedRaw) ? _selectedRaw : null
  const contextAnchor = selectedObj ? {
    x: selectedObj.x * viewport.scale + viewport.x,
    y: selectedObj.y * viewport.scale + viewport.y,
    width: selectedObj.width * viewport.scale,
    height: selectedObj.height * viewport.scale,
  } : null

  // ContextBar 应用候选 — 替换 / 新增 都把候选作为新对象插入画布
  const handleApplyCandidate = useCallback((
    cand: GenerationCandidate,
    action: 'replace' | 'add',
    sourceImageId: string,
  ) => {
    push()
    // 只看 image 类型(placeholder 没有 image_id)
    const source = objects.find((o): o is CanvasImageObject =>
      isImageObject(o) && o.image_id === sourceImageId)
    const baseX = source ? source.x + 40 : 100
    const baseY = source ? source.y + 40 : 100
    const newObj: CanvasImageObject = {
      type: 'image',
      id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      image_id: cand.image_id,
      src: api.images.fileUrl(cand.image_id),
      x: action === 'replace' && source ? source.x : baseX,
      y: action === 'replace' && source ? source.y : baseY,
      width: cand.w,
      height: cand.h,
      rotation: 0,
      selected: false,
    }
    setObjects((prev) => {
      if (action === 'replace' && source) {
        return prev.map((o) => (o.id === source.id ? { ...newObj, x: source.x, y: source.y } : o))
      }
      return [...prev, newObj]
    })
    setSelectedId(newObj.id)
  }, [push, objects, setObjects, setSelectedId])

  const handleStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    // 点击 Stage 本身(不是上面的 image 节点)→ 取消选中
    if (e.target === e.target.getStage()) {
      setSelectedId(null)
    }
  }, [setSelectedId])

  // 中键拖动 = 平移(Figma 一致)。用 ref 状态,避免每次拖都 setState 触发渲染。
  const middlePanRef = useRef<{ startX: number; startY: number; startVx: number; startVy: number } | null>(null)
  const [middlePanning, setMiddlePanning] = useState(false)

  const onContainerMouseDown = (e: React.MouseEvent) => {
    // 鼠标中键(button === 1)→ 进入临时平移模式
    if (e.button === 1) {
      e.preventDefault()
      middlePanRef.current = {
        startX: e.clientX, startY: e.clientY,
        startVx: viewport.x, startVy: viewport.y,
      }
      setMiddlePanning(true)
      const onMove = (ev: MouseEvent) => {
        const d = middlePanRef.current
        if (!d) return
        setViewport((v) => ({ ...v,
          x: d.startVx + (ev.clientX - d.startX),
          y: d.startVy + (ev.clientY - d.startY),
        }))
      }
      const onUp = () => {
        middlePanRef.current = null
        setMiddlePanning(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
  }

  // 平移:空格按下时整个 stage 可拖拽
  const stageDraggable = spaceDown
  const cursor = useMemo(() => {
    if (middlePanning) return 'grabbing'
    if (spaceDown) return 'grab'
    return 'default'
  }, [spaceDown, middlePanning])

  return (
    <div
      ref={containerRef}
      onMouseDown={onContainerMouseDown}
      className="relative h-full w-full overflow-hidden bg-foreground/[0.015]"
      style={{ cursor, backgroundImage: 'radial-gradient(rgba(0,0,0,0.05) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
    >
      {objects.length === 0 && !isDragging && (
        <CanvasEmpty onPickFromLibrary={() => setShowPicker(true)} />
      )}
      <ImageDropOverlay visible={isDragging} />

      {/* 右上角浮层:从资产库选图。空态时藏起,因为 CanvasEmpty 已经给了入口 */}
      {objects.length > 0 && (
        <div className="absolute top-3 right-3 z-10">
          <Button
            variant="outline" size="sm"
            className="h-7 text-[12px] bg-background/95 backdrop-blur-sm
                       shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
            onClick={() => setShowPicker(true)}
          >
            <FolderOpen size={12} className="mr-1.5" />
            从资产库选择
          </Button>
        </div>
      )}

      <CanvasToolbar
        scalePercent={viewport.scale * 100}
        onResetView={resetView}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        lastSavedAt={lastSavedAt}
        onClearCanvas={() => {
          if (objects.length === 0) {
            clearCanvas()
            return
          }
          const ok = confirm('清空画布?\n\n当前画布上的所有对象会被移除,Prompt 草稿也会清空。\n图片本身仍保留在资产库,可以稍后从资产库重新拉回。')
          if (ok) clearCanvas()
        }}
      />

      {size.w > 0 && (
        <Stage
          ref={stageRef}
          width={size.w}
          height={size.h}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          x={viewport.x}
          y={viewport.y}
          draggable={stageDraggable}
          onWheel={handleWheel}
          onMouseDown={handleStageClick}
          onTouchStart={(e) => {
            // Konva 的 mouse / touch 事件类型不通用 — touch handler 自己处理
            if (e.target === e.target.getStage()) setSelectedId(null)
          }}
          onDragEnd={(e) => {
            // 仅当拖的是 Stage 本身(空格平移),才更新 viewport;
            // 拖单个 image 节点不会冒泡到这里(Konva 事件模型)
            if (e.target === stageRef.current) {
              setViewport((v) => ({ ...v, x: e.target.x(), y: e.target.y() }))
            }
          }}
        >
          <Layer>
            {objects.map((obj) => {
              if (isPlaceholderObject(obj)) {
                return (
                  <CanvasPlaceholder
                    key={obj.id}
                    obj={obj}
                    isSelected={selectedId === obj.id && !maskMode}
                    onSelect={() => { if (!maskMode) setSelectedId(obj.id) }}
                    onRemove={() => {
                      setObjects((prev) => prev.filter((x) => x.id !== obj.id))
                      setSelectedId(null)
                    }}
                    onRetry={() => { /* PR-17 follow-up: 通过 atom 把 retry 信号传给 PromptBar */ }}
                  />
                )
              }
              return (
                <CanvasImage
                  key={obj.id}
                  obj={obj}
                  isSelected={selectedId === obj.id && !maskMode}
                  onSelect={() => { if (!maskMode) setSelectedId(obj.id) }}
                  onChange={(next) => updateObject(next)}
                  onCommit={push}
                />
              )
            })}
          </Layer>
          {/* 画笔层 — 仅在 maskMode 时挂载,记录笔触供 exportMask 使用 */}
          {maskMode && maskObj && (
            <MaskBrush
              ref={maskBrushRef}
              objBounds={{
                x: maskObj.x, y: maskObj.y,
                width: maskObj.width, height: maskObj.height,
              }}
              brushSize={brushSize}
              active={true}
              onStrokesChange={setMaskHasStrokes}
            />
          )}
        </Stage>
      )}

      {/* 选中图片 → 浮出 ContextBar(画笔 / outpaint 模式下 hide,避免和工具条重叠) */}
      {selectedObj && contextAnchor && !maskMode && !outpaintMode && (
        <ContextBar
          imageId={selectedObj.image_id}
          objectId={selectedObj.id}
          objBounds={{
            x: selectedObj.x, y: selectedObj.y,
            width: selectedObj.width, height: selectedObj.height,
          }}
          anchor={contextAnchor}
          containerHeight={size.h}
          onApplyCandidate={handleApplyCandidate}
        />
      )}

      {/* PR-10 任意扩图 8 手柄 overlay */}
      {outpaintMode && outpaintObj && (
        <OutpaintOverlay
          sourceBounds={{
            x: outpaintObj.x, y: outpaintObj.y,
            width: outpaintObj.width, height: outpaintObj.height,
          }}
          viewport={viewport}
          busy={outpaintBusy}
          onCancel={() => setOutpaintMode(null)}
          onSubmit={(p) => { void submitOutpaint(p) }}
        />
      )}

      {/* PR-10 outpaint 候选弹层 */}
      <CandidateGrid
        open={!!outpaintCandidates}
        onClose={() => setOutpaintCandidates(null)}
        candidates={outpaintCandidates || []}
        opLabel={outpaintLabel}
        costUsd={outpaintCost}
        onApply={(cand, action) => {
          if (outpaintObj) handleApplyCandidate(cand, action, outpaintObj.image_id)
          setOutpaintCandidates(null)
          setOutpaintMode(null)
        }}
      />

      {/* 画笔模式工具条 */}
      {maskMode && maskObj && (
        <MaskToolbar
          type={maskMode.type}
          brushSize={brushSize}
          onBrushSize={setBrushSize}
          onUndo={() => { maskBrushRef.current?.undoStroke(); setMaskHasStrokes(!!maskBrushRef.current?.hasStrokes()) }}
          onClear={() => { maskBrushRef.current?.clearAll(); setMaskHasStrokes(false) }}
          canUndo={maskHasStrokes}
          onCancel={() => { setMaskMode(null); setMaskHasStrokes(false) }}
          onSubmit={(p) => { void submitMask(p) }}
          busy={maskBusy}
        />
      )}

      {/* 画笔候选弹层 — 用户挑了之后调通用 handleApplyCandidate 落画布 */}
      <CandidateGrid
        open={!!maskCandidates}
        onClose={() => setMaskCandidates(null)}
        candidates={maskCandidates || []}
        opLabel={maskOpLabel}
        costUsd={maskCost}
        onApply={(cand, action) => {
          if (maskObj) handleApplyCandidate(cand, action, maskObj.image_id)
          setMaskCandidates(null)
          setMaskMode(null)  // 选完候选自动退出画笔模式
        }}
      />

      <SeedPickerDialog
        open={showPicker}
        onClose={() => setShowPicker(false)}
        initialSelected={[]}
        onConfirm={(imgs) => {
          setShowPicker(false)
          insertImagesToCanvas(imgs)
        }}
        title="从资产库选择 — 添加到画布"
        confirmLabel="添加到画布"
      />
    </div>
  )
}
