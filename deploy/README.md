# 灵图 Sidecar — 云端服务器部署

> 面向 UGC 平台 / 第三方对接方。本机 Electron 桌面用户**不需要**这套部署。
>
> 本文档假定你已读过 `docs/部署架构与对外接口.md` —— 那是为什么这么部署，本文是怎么部署。

## 架构一句话

```
本地 sidecar (打标 / 生图 / 调试)
   │ sync_worker 推 metadata + embedding + tags
   ▼
云端 sidecar + PostgreSQL  ←──── /open-api/v1/* ────  UGC 前端
                                                       │
                                ┌──────────────────────┘
                                ▼
                          阿里云 OSS / CDN
                          (图片二进制，不经过 sidecar)
```

云端 sidecar 是**只读数据面**：本地推什么进来它就服务什么；本身不打标、不生图、不写本地数据。

## 一次性准备

### 1. 服务器资源

最小推荐：
- 阿里云 ECS：2C 4G，Ubuntu 22.04+，50GB SSD（约 ¥150/月）
- 域名 + SSL：`api.your-domain.com` + 阿里云免费证书 / Let's Encrypt
- 阿里云 OSS bucket（图片 CDN，已有的话沿用）

### 2. 安装 Docker

```bash
# Ubuntu 22.04+
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# 退出重登 SSH 让 group 生效
```

### 3. 克隆 + 配置

```bash
git clone <你的 lintu 仓库 URL> /srv/lintu
cd /srv/lintu/deploy
cp .env.example .env
nano .env   # 编辑，下面会逐项说明
```

`.env` 必填项：

| 变量 | 含义 | 示例 |
|---|---|---|
| `POSTGRES_PASSWORD` | 数据库密码（容器内 PG） | `openssl rand -base64 32` |
| `LINTU_INTERNAL_SYNC_TOKEN` | 本地 ↔ 云端同步用的内部 token | `openssl rand -hex 32` |
| `LINTU_ALLOW_CORS` | UGC 前端域名白名单 | `https://ugc.example.com` |

可选：

| 变量 | 含义 |
|---|---|
| `LINTU_DEFAULT_IMAGE_EMBEDDING_PROVIDER` | 让云端能 embed 文本时用，例 `relay:ark` |
| `LINTU_CUSTOM_RELAYS` | JSON 字符串，定义 relay 接入点（base_url + key + model） |

### 4. 启动

```bash
docker compose up -d
docker compose logs -f sidecar
```

启动 30 秒内健康检查：

```bash
curl http://localhost:7879/health
# {"status":"ok","mode":"server"}
```

### 5. 反向代理 + TLS

容器只监听 `7879/HTTP`。生产用 nginx 套 TLS：

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    # ... TLS config ...

    location / {
        proxy_pass http://127.0.0.1:7879;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE — disable buffering, extend read timeout
        proxy_buffering off;
        proxy_read_timeout 600s;
        client_max_body_size 50m;
    }
}
```

### 6. 配置本地端推送到这台云端

回到本地（运营人员的桌面机）打开 `apps/sidecar/.env` 或启动脚本，加：

```bash
export LINTU_CLOUD_SYNC_URL=https://api.your-domain.com
export LINTU_INTERNAL_SYNC_TOKEN=同上面云端 .env 里的值
```

下次启动桌面端 / sidecar 时会自动开始推送（增量）。

### 7. 首次全量回填

新部署的云端是空的。回到本地跑：

```bash
cd /Users/yang/projects/lintu/apps/sidecar
LINTU_CLOUD_SYNC_URL=https://api.your-domain.com \
LINTU_INTERNAL_SYNC_TOKEN=... \
  uv run python scripts/sync_to_cloud_bulk.py
```

这会把所有 projects / images / tags / api_keys / synonyms / tag_schema 一次性推到云端。3500 张图大约 30 秒。

### 8. UGC 联调

```bash
TOKEN="lk_live_xxx.your_secret"
curl -i -H "Authorization: Bearer $TOKEN" \
  https://api.your-domain.com/open-api/v1/stats
```

返回 200 + 项目库存数据 → 全链路通了。

## 数据目录

容器内 `/data` 挂载到宿主 `./data/`：

```
deploy/
├── data/
│   ├── lintu.db                 # SQLite 文件（仅 alembic state，云端实际数据在 PG）
│   └── workspace/
└── pgdata/                      # PostgreSQL 数据卷
    └── ...
```

**备份**：

```bash
# PostgreSQL 备份
docker compose exec postgres pg_dump -U lintu lintu > backup-$(date +%F).sql

# OSS 镜像（图片）阿里云控制台已有自动备份机制
```

**恢复**：

```bash
docker compose exec -T postgres psql -U lintu lintu < backup-2026-04-28.sql
```

## 常见操作

```bash
# 查看实时日志
docker compose logs -f sidecar

# 进入数据库
docker compose exec postgres psql -U lintu lintu

# 重启
docker compose restart sidecar

# 升级镜像
git pull
docker compose build sidecar
docker compose up -d sidecar

# 看 sync 收到了哪些数据（应当随时间增长）
docker compose exec postgres psql -U lintu lintu -c "
SELECT project_id, COUNT(*) FROM images GROUP BY project_id;"
```

## 故障排查

| 现象 | 检查 |
|------|------|
| 容器一直重启 | `docker compose logs sidecar` 看 alembic 迁移；多半是 PG 还没 ready，等 30 秒 |
| `/health` 200 但 `/open-api/v1/stats` 401 | 没带 Bearer token，或 token 已被停用 |
| 401 `invalid credentials` | secret 不对，或本地 rotate 后没等到 sync 推送（看下面同步状态） |
| 403 `forbidden_origin` | 请求 Origin 不在 Key 的 `allowed_origins` 里 |
| 429 `rate limit` | 触发 Key 的 per_minute / per_day 限流 |
| 浏览器 CORS 错误 | `.env` 加 UGC 域名到 `LINTU_ALLOW_CORS`，重启 |
| 本地 sync 没推过来 | 本地终端确认 `LINTU_CLOUD_SYNC_URL` / token 设置；本地 sidecar 日志看 cloud_sync_worker；查看本地 `cloud_sync_jobs` 表的 `status` 字段 |
| 匹配返回空 | 可能云端只有项目没有 images。在本地跑全量回填脚本（步骤 7） |

## 安全清单

- [ ] `POSTGRES_PASSWORD` 是 32+ 位随机串，不在源码里
- [ ] `LINTU_INTERNAL_SYNC_TOKEN` 是 32+ 位随机串，本地和云端两边一致
- [ ] PG 端口 `5432` **不**对公网开放（compose 里限定 `127.0.0.1`）
- [ ] nginx 配置 HSTS + 只接受 TLS 1.2+
- [ ] OSS bucket 的 `i/*` 路径设为公网可读（仅图片，不含元数据）
- [ ] OSS AccessKey 不放在云端 sidecar（云端只读元数据，不上传图片）
- [ ] 阿里云安全组只开 80 / 443 / 22
- [ ] SSH 改 key 登录，禁用 password
- [ ] `.env` 文件权限 600，不入 git

## 升级流程

```bash
# 在本地拉最新代码 + commit + push
git push origin v0.2

# 在云端
cd /srv/lintu
git pull
cd deploy
docker compose build sidecar
docker compose up -d sidecar    # zero-downtime: 老容器在新容器健康前不停
# 看新容器健康
docker compose logs -f sidecar
```

如果 schema 有变更（新加了表 / 列），新容器启动时 alembic 会自动 `upgrade head`。
