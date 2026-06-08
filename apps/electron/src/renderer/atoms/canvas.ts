import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { ImageRecord } from '@/lib/types'

/**
 * 画布对象 — 两种 type:
 *   - 'image':真实图像对象(已落盘 + 有 image_id)
 *   - 'placeholder':生成中 / 生成失败的占位框,等结果回来替换成 image
 *
 * 引入 placeholder 的原因(v0.3 PR-17):用户点「生成」后,fetch 可能要 5-30s,
 * 期间用户切走 / 选别的图,**任务不能丢**。让 placeholder 立刻出现在画布上,
 * fetch 作为 fire-and-forget,完成后用 setObjects 替换该 placeholder。
 * 同时画布的持久化机制天然让任务"幸存"app 重启(被中断的 pending 会在恢复时转 error)。
 */
export interface CanvasImageObject {
  type?: 'image'              // 显式 type;旧持久化数据没这字段,默认按 image 处理
  id: string                  // 客户端临时 id (cuid 风格);跟后端 ImageRecord.id 不一样
  image_id: string            // 对应的 ImageRecord.id,后端持久化用
  src: string                 // /api/images/{id}/file?token=...(带 token 的 URL)
  x: number                   // 画布坐标(逻辑像素,未应用 viewport.zoom)
  y: number
  width: number               // 原图宽
  height: number              // 原图高
  rotation: number            // 度,顺时针;Phase 1 不开放旋转 UI,但字段先留
  selected: boolean           // 多选场景预留;Phase 1 只支持单选
  /** 关联线:这张图由画布上哪些对象「发散」而来(img2img / Ask AI / 扩图 等的源对象 id)。
   *  渲染时从每个 source 画一条线指向本对象,形成发散式创作树。持久化。 */
  sourceObjectIds?: string[]
}

export interface CanvasPlaceholderObject {
  type: 'placeholder'
  id: string
  /** 'pending' = 生成中(spinner 转动) · 'error' = 失败(可重试)*/
  status: 'pending' | 'error'
  /** 头部展示文案:如 "文生图 · 一只猫..." */
  label: string
  /** 后端 type — 错误重试时用得着 */
  requestType: 'text2img' | 'img2img' | 'outpaint' | 'inpaint' | 'matting' | 'eraser' | 'upscale' | 'text-zh' | 'edit'
  /** 失败时的错误信息 — 渲染在 placeholder 内 */
  errorMessage?: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  selected: boolean
  /** 同 image:占位框也记录来源对象,这样生成中就能看到关联线,完成后无缝延续。 */
  sourceObjectIds?: string[]
}

export type CanvasObject = CanvasImageObject | CanvasPlaceholderObject

/** type guards — 让 .ts 收窄类型 */
export const isImageObject = (o: CanvasObject): o is CanvasImageObject =>
  o.type !== 'placeholder'
export const isPlaceholderObject = (o: CanvasObject): o is CanvasPlaceholderObject =>
  o.type === 'placeholder'

/**
 * 画布上所有对象的列表 — 渲染顺序 = 数组顺序(数组靠后 = z 轴更高)。
 */
export const canvasObjectsAtom = atom<CanvasObject[]>([])

/**
 * 当前选中对象的 id;null = 没选中(整个画布点击空白处会清掉)。
 * 用单选而非多选,匹配 PRD「选中图片后浮出上下文操作栏」语义。
 */
export const selectedObjectIdAtom = atom<string | null>(null)

/**
 * Viewport — 画布的平移 + 缩放状态。
 * 注意:Konva 的 Stage 自己管理 scaleX/scaleY/x/y,我们的 atom 是「真相源」,
 * Stage 当作受控组件,每次变化都回写到 atom,这样 zoom 显示和 undo/redo 都好做。
 */
export interface CanvasViewport {
  scale: number   // 1 = 100%
  x: number       // 平移 x (画布坐标系)
  y: number       // 平移 y
}

export const canvasViewportAtom = atom<CanvasViewport>({ scale: 1, x: 0, y: 0 })

/** 画布 DOM 容器的尺寸(像素)。CanvasStage 用 ResizeObserver 更新,
 *  PromptBar / HistoryPanel 拉它来精确算"屏幕中心 → 世界坐标"。
 *  不持久化(每次 mount 由 ResizeObserver 写)。 */
export const canvasStageSizeAtom = atom<{ w: number; h: number }>({ w: 0, h: 0 })

/**
 * 画布当前的"生成参数草稿" — PromptBar 写入,PropertyPanel 读出来构造
 * 「存为策略」时的 canvas_snapshot。让两个组件不需要 prop drilling。
 *
 * 这里只放跟"未来批量复用"相关的字段;视图相关(viewport / selection)不进 snapshot。
 */
export interface CanvasParams {
  mode: 'text2img' | 'img2img'
  prompt: string
  target_w: number
  target_h: number
  ratio_label: string
  speed: 'draft' | 'refined'
  count: number
  style_archive_id?: string | null
}

export const canvasParamsAtom = atom<CanvasParams>({
  mode: 'text2img',
  prompt: '',
  target_w: 1024,
  target_h: 1024,
  ratio_label: '1:1',
  speed: 'refined',
  count: 1,
  style_archive_id: null,
})

// v0.3 PR-9:画笔模式 — 局部重绘 / 智能消除 共用。
// 非空时:CanvasStage 在选中对象上叠加 MaskBrush 层 + 顶部显示 MaskToolbar,
// 此时常规 ContextBar / Transformer 都隐藏掉,让用户专注涂抹。
export interface MaskMode {
  type: 'inpaint' | 'eraser'
  objectId: string         // canvas object id;不是 image_id,因为画布上同一张图可能有多个对象
}
export const maskModeAtom = atom<MaskMode | null>(null)

// v0.3 PR-10:Outpaint mode — 选中对象进入 8 手柄外扩态。
// 非空时:CanvasStage 在选中对象周围渲染 OutpaintOverlay,常规交互被托管。
export interface OutpaintMode {
  objectId: string
  /** Target rectangle in CANVAS coords(不含 viewport scale)。
   *  原图始终保留在 (object.x, object.y, object.width, object.height),
   *  target 可大于(意为扩图),不能小于原图。 */
  targetX: number
  targetY: number
  targetW: number
  targetH: number
}
export const outpaintModeAtom = atom<OutpaintMode | null>(null)

// ── v0.3 PR-13:PromptBar 的草稿 state 升为 atom ──────────────────────
// 原本在 PromptBar 组件里的 local useState,提到 atom 是因为:
//   1. 持久化(见下方 canvasSnapshotsAtom)— 需要外部能读到 prompt / refs
//   2. 后续可能想从画布上下文(ContextBar / 候选弹层)反向操作 prompt 栏
// `refs` 是用户拖入 PromptBar 输入框区的参考图,不在画布上(跟 canvasObjectsAtom 区分)。
export const promptBarPromptAtom = atom<string>('')
export const promptBarRefsAtom = atom<ImageRecord[]>([])

// ── v0.3 PR-16:画布持久化(per-project)──────────────────────────────
//
// 设计:
//   - 单 localStorage key,值是 { [projectId]: PersistedCanvas }
//   - useCanvasPersistence hook 负责双向同步(load on project change /
//     save debounced on changes),保持现有内存 atoms 接口不变
//   - 切项目自动恢复对应快照;清空对象 = 把当前项目的 entry 删掉
//
// 不持久化的状态(刻意,语义上是"瞬态交互"):
//   - selectedObjectId(选中状态)
//   - maskMode / outpaintMode(画笔 / 8 手柄态)
//   - canvasParams.prompt(已被 promptBarPromptAtom 单独承载,二选一持久即可)
//
// 为什么不直接把 canvasObjectsAtom 等改成 atomWithStorage:
//   - atomWithStorage 在 set 时同步写存储,高频拖拽会持续 stringify 重对象
//   - 用单独 snapshot atom + 防抖 = 单次写入,性能可控
export interface PersistedCanvas {
  /** image + placeholder 都持久化;pending placeholder 恢复时转 error(任务已被重启打断) */
  objects: CanvasObject[]
  viewport: CanvasViewport
  params: CanvasParams
  refs: ImageRecord[]
  prompt: string
  updated_at: string  // ISO
}

// 注意:必须传 getOnInit:true。jotai 默认 getOnInit:false 时 atom 初始值永远是 {},
// **不读 localStorage** — 之前刷新后 load effect 看到空快照 → 清画布 → 防抖保存
// 把空状态写回存储,真实数据被覆盖销毁。getOnInit:true 让初始化时同步读取存档。
export const canvasSnapshotsAtom = atomWithStorage<Record<string, PersistedCanvas>>(
  'lintu.canvas.snapshots.v1',
  {},
  undefined,
  { getOnInit: true },
)
