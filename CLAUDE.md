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
