# 灵图 Sidecar — 服务器部署

面向 H5 / 第三方对接方。本机 Electron 桌面用户**不需要**这套部署。

## 一次性准备

```bash
cd deploy
cp .env.example .env
# 编辑 .env，填入允许跨域访问的 origin（H5 域名）
# 例: LINTU_ALLOW_CORS=https://h5.example.com,*.partner.com
```

## 启动

```bash
docker compose up -d
docker compose logs -f sidecar
```

启动后健康检查：

```bash
curl http://localhost:7879/health
# {"status":"ok","mode":"server"}

curl http://localhost:7879/open-api/v1/health
# {"status":"ok","version":"v1"}    ← 公开端点，无需鉴权
```

## 创建 API Key

服务器模式下 `/api/*` 管理路由被禁用。**Key 必须在桌面端 Electron 应用里创建**：

1. 打开灵图桌面端 → 分发中心 → API Keys → 新建
2. 复制弹窗里的 `Bearer Token`（仅显示一次）
3. 把同一份 SQLite (`data/lintu.db`) 拷到服务器，或用任意支持 SQLite 的方式让两端共享

> 未来一旦做 server-mode key 管理 CLI，会从这里更新说明。

## 验证鉴权

```bash
TOKEN="lk_live_xxx.your_secret"

# 401 — 没带 token
curl -i http://localhost:7879/open-api/v1/stats

# 200 — 带 Bearer
curl -i -H "Authorization: Bearer $TOKEN" http://localhost:7879/open-api/v1/stats
```

## 数据目录

容器内 `/data` 挂载到宿主 `./data/`：

```
deploy/data/
├── lintu.db                  # 主库
├── lintu.db-wal              # WAL（运行时存在）
├── lintu.db-shm              # Shared memory
└── workspace/
    ├── thumbnails/           # 缩略图缓存
    ├── generated/            # 批次生成的图片
    └── prompt_docs/          # 上传的 prompt 文档
```

**备份**：每天 `cp -r data/ backups/$(date +%F)/` 即可。SQLite WAL 模式下 `cp` 是原子安全的（要么取到 commit 前快照，要么取到 commit 后），不会破坏数据库。

**恢复**：把整个 `data/` 还原回去，重启容器，alembic 会自动 upgrade head。

## 反向代理（生产 TLS）

容器只监听 7879/HTTP。生产请用 nginx / caddy 套 TLS：

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    # ... your TLS config ...

    location / {
        proxy_pass http://127.0.0.1:7879;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE — disable buffering and extend read timeout
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
```

## 常见操作

```bash
# 查看实时日志
docker compose logs -f sidecar

# 重启
docker compose restart sidecar

# 升级镜像
git pull
docker compose build sidecar
docker compose up -d sidecar

# 临时切到 electron 模式（开发调试用）
LINTU_MODE=electron docker compose up sidecar
```

## 故障排查

| 现象 | 检查 |
|------|------|
| `/health` 200 但 `/open-api/v1/stats` 401 | 没带 Bearer token，或 token 已被停用/过期 |
| 401 detail: "invalid credentials" | secret 不对，或 Key 在桌面端被 rotate |
| 403 detail: "forbidden_origin" | 请求 Origin 不在 Key 的 `allowed_origins` 内 |
| 429 detail: "rate limit ..." | 触发了 Key 的 per_minute / per_day 限流 |
| 浏览器 CORS 错误 | 在 `.env` 把请求方域名加进 `LINTU_ALLOW_CORS`，重启 |
| 容器一直重启 | `docker compose logs sidecar` 看 alembic 迁移是否失败；最常见是 DB 文件权限问题 |
