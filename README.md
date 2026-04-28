# 灵图 (Lintu)

景区图片 AI 生产平台。把原图扫进来 → 自动质检 / 去重 / 打标 / 算向量 → 用 AI 大批量生成衍生图 → 通过对外 API 把图库供 UGC 平台按文本检索调用。

桌面应用（Electron + Python sidecar），支持本地优先 + 云端只读副本的混合部署。

---

## 技术栈

- **前端**：Electron 39 + React 18 + TypeScript + Tailwind v4 + Jotai + Radix UI
- **后端**：Python 3.12 + FastAPI sidecar（端口 7879）+ SQLite + Alembic + asyncio
- **AI**：豆包 Doubao Vision Pro/Lite（打标）+ doubao-embedding-vision-251215（跨模态向量）+ Doubao Seedream / Gemini / GPT-Image（生图）
- **存储**：本地文件 + 阿里云 OSS（图片 CDN）
- **构建**：esbuild（主进程）+ Vite（渲染进程）+ uv（Python）+ electron-builder

---

## 项目结构

```
lintu/
├── apps/
│   ├── electron/           # Electron + React 前端
│   │   ├── src/
│   │   │   ├── main/       # Electron 主进程（spawn sidecar）
│   │   │   ├── preload/
│   │   │   └── renderer/   # React app
│   │   ├── electron-builder.yml
│   │   └── package.json
│   └── sidecar/            # Python FastAPI 后端
│       ├── sidecar/
│       │   ├── routers/    # /api/* + /open-api/v1/*
│       │   ├── engines/    # 打标 / 生图 / 匹配 / 嵌入
│       │   ├── scheduler/  # 任务调度
│       │   ├── middleware/ # 鉴权 / 限流 / 审计
│       │   ├── providers/  # AI 服务商抽象
│       │   └── db/         # SQLAlchemy + Alembic
│       ├── alembic/
│       └── pyproject.toml
├── deploy/                 # Docker compose for server-mode
└── docs/                   # 全部文档（见下）
```

---

## 文档地图

> 不同角色看不同文档 —— 先选适合自己的入口。

| 文档 | 给谁看 | 内容速记 |
|---|---|---|
| [`docs/产品手册与使用说明.md`](docs/产品手册与使用说明.md) | **团队所有人**（推荐先看） | 概念、首启、推荐工作流、9 模块详解、设置、快捷键、FAQ |
| [`docs/部署架构与对外接口.md`](docs/部署架构与对外接口.md) | 外部技术协作者 | 自包含的部署方案对比 + 接口设计，可直接发外部 |
| [`docs/匹配策略与部署架构.md`](docs/匹配策略与部署架构.md) | 内部同事，了解匹配算法细节 | 跨项目匹配策略 + 4 个部署方案 + 落地计划 |
| [`docs/UGC-OPEN-API-PRD.md`](docs/UGC-OPEN-API-PRD.md) | 产品经理 / 接口需求方 | UGC 接入 API 的需求规格 |
| [`docs/UGC-INTEGRATION-GUIDE.md`](docs/UGC-INTEGRATION-GUIDE.md) | 对接 UGC 的开发 | 调用方集成指南 + curl/JS demo |
| [`docs/MATCH-STRATEGY-DETAILS.md`](docs/MATCH-STRATEGY-DETAILS.md) | 匹配策略调优 | 5 信号评分 + RRF + diversity 后处理细节 |
| [`docs/OSS-SETUP-GUIDE.md`](docs/OSS-SETUP-GUIDE.md) | 配阿里云 OSS 的同事 | OSS bucket / RAM / CDN 配置步骤 |
| [`docs/open-api-guide.md`](docs/open-api-guide.md) | API 接入方 | 鉴权 / 错误码 / 完整端点 reference |

---

## 开发环境

### 一次性安装

```bash
# Node 20+ + bun
curl -fsSL https://bun.sh/install | bash

# Python 3.12 + uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# 项目依赖
cd apps/electron && bun install
cd ../sidecar && uv sync
```

### 启动开发模式

```bash
# 终端 1：Vite dev server
cd apps/electron
bunx vite --config vite.config.ts

# 终端 2：Electron（自动 spawn sidecar via uv run）
cd apps/electron
bunx electron .
```

或者两个一起：

```bash
cd apps/electron && bun run start
```

### 单独启动 sidecar（用于 API 调试）

```bash
cd apps/sidecar
LINTU_API_CONCURRENCY=8 LINTU_CPU_CONCURRENCY=3 \
  uv run uvicorn sidecar.main:app --port 7879 --host 127.0.0.1
```

`LINTU_MODE=electron`（默认）开放 `/api/*` admin 接口；`LINTU_MODE=server` 关掉 admin 只暴露 `/open-api/v1/*`，配合 `LINTU_ALLOW_CORS` 给云端部署用。

---

## 数据库迁移

使用 Alembic。schema 改动后：

```bash
cd apps/sidecar
uv run alembic revision -m "your change description"
# 编辑 alembic/versions/*.py
uv run alembic upgrade head
```

启动 sidecar 时会自动跑 `alembic upgrade head`，生产环境无需手动操作。

---

## 构建生产包

### macOS

```bash
cd apps/electron
bun run build
bunx electron-builder --mac --arm64
# 产物：apps/electron/release/灵图-*.dmg
```

### Windows（待落地，详见部署文档）

需要在 Windows 机器上执行 PyInstaller 打包 sidecar，然后 electron-builder 整合。CI/Actions 自动化方案见 `docs/部署架构与对外接口.md` 的"实现工时预估"章节。

---

## 仓库约定

- **commit message**：用中文描述意图，开头标版本（例 `v0.2: ...`）或动词（`Fix:` / `Add:` / `Refactor:`）
- **分支策略**：当前默认 `v0.2`，特性开发分支 `feat/xxx` 或 `fix/xxx`
- **路径别名（前端）**：`@/` → `src/renderer/`
- **UI 语言**：中文标签，英文代码 / 组件名
- **不入仓**：`node_modules/` `.venv/` `*.db` `release/` `dist/` `__pycache__/`（已在 `.gitignore`）
- **secrets**：所有 API key / OSS AccessKey 走 `.env`（已 gitignore），代码里只能出现 `lk_live_xxx.placeholder` 类占位符

---

## License

私有项目，未授权不得分发。
