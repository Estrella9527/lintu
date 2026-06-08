# 灵图 (Lintu)

景区图片 AI 生产平台，Electron 桌面应用。

## 技术栈

- **前端**: Electron 39 + React 18 + TypeScript + Tailwind CSS v4 + Jotai + Radix UI
- **后端**: Python FastAPI sidecar (端口 7879) + SQLite + asyncio
- **构建**: esbuild (主进程) + Vite (渲染进程) + uv (Python)

## 项目结构

- `apps/electron/` — Electron + React 前端
- `apps/sidecar/` — Python FastAPI 后端

## 开发命令

```bash
# 前端
cd apps/electron
npx vite --config vite.config.ts    # 启动 Vite dev server (port 5173)
npx electron .                       # 启动 Electron (自动拉起 sidecar)

# 后端单独启动
cd apps/sidecar
uv run uvicorn sidecar.main:app --port 7879 --host 127.0.0.1
```

## 约定

- 前端路径别名: `@/` → `src/renderer/`
- 导航: 单 Jotai atom (`activeModuleAtom`) 驱动，无路由库
- 中文 UI 标签，英文代码和组件名
- 6色 OKLch 主题系统，深色模式通过 `<html class="dark">` 切换
- 禁止嵌套侧边栏、多级 Tab、非必要弹窗
- **所有 `/api/*` 调用必须经过 `lib/api.ts` 的 `apiFetchRaw()` / `api.*` 包装** — 自动注入 Bearer token；raw `fetch('http://localhost:7879/...')` 会被 `UserAuthMiddleware` 401。`<img>` / `EventSource` 用 `withTokenParam()` 拼 `?token=` query

## AI 工坊（v0.3+）

v0.3 把 AI 工坊从「线性表单 × 7 个内置策略 tab」改成 **「创作画布 + 批量策略」双模式**。同一时刻只展示一个 mode,顶部 `ModeTabs` 切换。

### 双模式架构
- **创作画布(canvas)**:基于 react-konva 的白板,**单图打样 / 试错 / 反复编辑**
  - `components/workshop/canvas/CanvasStage.tsx` — `<Stage>` 容器,zoom/pan/select/move/undo,接拖入/粘贴上传
  - `components/workshop/canvas/ContextBar.tsx` — 选中图后下方浮出的 AI 操作栏(Ask AI + 7 个操作)
  - `components/workshop/canvas/PromptBar.tsx` — 底部文生图 / 图生图
  - `components/workshop/canvas/PropertyPanel.tsx` — 右面板属性 + 「存为策略」「加入资产库」
  - 视觉:`bg-foreground/[0.015]` + dot grid,选中描边 `stroke=hsl(--accent)`,所有 UI 都用 lintu 现有组件库
- **批量策略(batch)**:多种子 × 多 prompt 的生产线,复用 v0.2 的 BatchScheduler
  - `components/workshop/BatchMode.tsx` — 现阶段保留 strategy tabs + StrategyPage + BatchRunDialog(v0.2 完成)
  - from_canvas 来源策略带 📐 标识,hover 显示「回画布」按钮 → 切回 canvas mode + 用 canvas_snapshot 预填 PromptBar

### 桥接(双模式共享数据)
- **存为策略**(canvas → batch):画布右面板「存为策略」→ `POST /api/strategies` 带 `provenance='from_canvas'` + 完整 `canvas_snapshot` JSON,批量策略列表立刻可选
- **回画布微调**(batch → canvas):批量策略 from_canvas tab 的 hover「回画布」→ 读 canvas_snapshot 还原到 `canvasParamsAtom` + 切 mode='canvas'
- **风格档案 StyleArchive**:画布 / 批量配置共用 `<StyleArchivePicker>`;CRUD 在 设置 → 风格档案 Tab

### 统一图像生成端点
- `POST /api/generate` — 9 个 type(text2img / img2img / outpaint / inpaint / matting / eraser / upscale / text-zh / edit),前端只关心 type,后端按 type 路由
- Phase 1 全部 type 路由到 OpenAICompatProvider 的 image2 模型(`gpt-image-2` / `seedream-2`),通过 prompt 前缀注入 type 语义(见 `engines/generation_dispatch.py` 的 `_TYPE_PREFIXES`)
- 后期 Agent 阶段再做 per-type 模型 routing
- 所有生成产物自动落 ImageRecord(`source_type='generated'`)+ 入 OSS 同步队列,无需手动「加入资产库」

### 关键 atoms(`atoms/workshop.ts` / `atoms/canvas.ts`)
- `workshopModeAtom`: 'canvas' | 'batch'
- `workshopBatchDialogAtom`: 控制 BatchRunDialog 可见性,跨页面 hand-off 用
- `canvasObjectsAtom`: 画布上所有 image 对象
- `selectedObjectIdAtom`: 单选,驱动 ContextBar 浮出
- `canvasViewportAtom`: scale + x + y
- `canvasParamsAtom`: PromptBar 当前配置,PropertyPanel 读出来构造 canvas_snapshot

### v0.3 砍掉的 PRD 项(留 v0.4)
- 语义图层 SemanticLayers / 智能体 AgentPlan / 质量基线 8 锚点回归 — 全部留 v0.4
- 真 8 手柄拖拽外扩(当前用 OutpaintDialog Modal 输入数字)
- 局部重绘 inpaint / 智能消除 eraser 的画笔涂抹(按钮存在但 toast「下个版本」)
- 三栏 BatchMode + 覆盖矩阵补 gap 联动 — 当前 BatchMode 仍是 v0.2 的 strategy tabs + BatchRunDialog
- 实时 SSE 生图进度(当前同步阻塞 5-30s)

## 用户系统（v0.1.5+）

- **身份层**：手机号 + 阿里云短信验证码登录；唯一登录通道
- **会话**：opaque token + sha256 hash 落 `sessions` 表；30 天有效，前端每 6 小时自动 `/api/auth/refresh`
- **角色**：`is_root=True` = 超级管理员；其余用户 Phase 1 全 `member`，**不区分细粒度权限**（Phase 2 才拆 admin / operator）
- **隔离**：`db/tenant.py` 的 `with_loader_criteria` 把 `WHERE project_id IN (...)` 自动注入到 `TENANT_TABLES` 的 SELECT；`before_flush` 校验写入。**裸 SQL（`text(...)`）不被覆盖**
- **中间件链**（外 → 内）：Audit → OperationLog → UserAuth → Tenant → ApiKey(`/open-api/*`) → RateLimit → Quota → app
- **运维 CLI**：`uv run python -m sidecar.cli.admin {bootstrap-root, add-member, reset-root}`
- **完整 onboarding**：`docs/operations/user-system-onboarding.md`

## Agent 团队（`.claude/agents/`）

按场景调用对应子代理。每个 agent 都已固化职责、输出格式、关键约束和必读上下文。

| Agent | 模型 | 调用场景 |
|---|---|---|
| `lintu-pm` | sonnet | 需求分析 / PRD / 优先级排期 |
| `lintu-opr` | sonnet | 生产侧 + 消费侧的运营 SOP / 数据回流 |
| `lintu-ux` | sonnet | 信息架构 / 交互原则 / 流程梳理 |
| `lintu-ui` | sonnet | 视觉规范 / OKLch 主题 / 组件 spec |
| `lintu-fe` | sonnet | Electron 渲染层 React/TS/Tailwind 开发 |
| `lintu-be` | sonnet | FastAPI sidecar / SQLAlchemy / 同步逻辑 |
| `lintu-alg` | opus | 匹配策略调优 / bad case / A/B 实验 |
| `lintu-qa` | sonnet | 测试用例 / 回归方案 / 性能基准 |
| `lintu-ops` | sonnet | CI/CD / 监控告警 / 备份 / 灰度发布 |

跨域工作走「PM 拆解 → 角色并行 → QA 验收 → OPS 部署」的链路；不要单角色强行兜底所有事。
