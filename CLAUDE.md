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
