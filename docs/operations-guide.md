# 灵图运维与开发指南

> 面向**运营 + 开发同学**。覆盖日常运维、素材扩充、标签维护、API 服务、故障处理。
>
> 假定你已读过 [`部署架构与对外接口.md`](部署架构与对外接口.md) 并知道现有架构（本地 Electron 桌面 + 云端 sidecar 寄生部署在 192.0.2.1，对外 `https://api.example.com`）。

---

## 目录

- [1. 日常监控与健康检查](#1-日常监控与健康检查)
- [2. 图片素材库维护](#2-图片素材库维护)
- [3. 标签体系与同义词](#3-标签体系与同义词)
- [4. Embedding 向量化](#4-embedding-向量化)
- [5. 项目（景区）管理](#5-项目景区管理)
- [6. ApiKey 与 UGC 对接](#6-apikey-与-ugc-对接)
- [7. 同步到云端](#7-同步到云端)
- [8. 升级与发布](#8-升级与发布)
- [9. 备份与灾难恢复](#9-备份与灾难恢复)
- [10. 性能调优](#10-性能调优)
- [11. 开发与本地调试](#11-开发与本地调试)
- [12. 故障排查速查](#12-故障排查速查)

---

## 1. 日常监控与健康检查

### 服务入口
| 用途 | URL | 期望响应 |
|---|---|---|
| 云端健康检查 | `https://api.example.com/health` | `{"status":"ok","mode":"server"}` |
| OpenAPI v1 健康 | `https://api.example.com/open-api/v1/health` | `{"status":"ok","version":"v1"}` |
| Swagger 测试台 | `https://api.example.com/docs` | Swagger UI 页面 |
| 可视化测试台 | `https://api.example.com/demo/` | demo HTML 页面 |
| 内部 sync 健康（需 Bearer + IP 白名单） | `https://api.example.com/internal/sync/health` | `{"status":"ok",...}` |

### 推荐监控点（用阿里云监控 / Uptime Kuma / 你熟悉的工具）
- `/health` 200，每 1 分钟探测；连续 3 次失败告警
- HTTPS 证书过期提醒（当前 `*.example.com` 通配符到 2026-10-10）
- ECS CPU / 内存 / 磁盘使用率（重明 + 灵图共住，要看整体）
- 云端 PG 连接数（`docker exec` 进容器查也可）
- nginx access log 异常 IP / 高频 401-403（被人扫漏洞）

### 日志位置

**云端 ECS**：
```bash
# Sidecar 容器日志（包含 alembic 迁移、cloud_sync_worker、所有请求）
docker logs lintu-sidecar           # 全量
docker logs -f --tail 100 lintu-sidecar   # 实时跟最近 100 行

# Nginx 访问/错误日志
sudo tail -f /var/log/nginx/lintuapi.access.log
sudo tail -f /var/log/nginx/lintuapi.error.log

# 系统日志（容器异常退出 / OOM）
sudo journalctl -u docker --since "1 hour ago"
```

**本地 macOS**：
```bash
# Sidecar 日志（Electron 启动时的 stdout/stderr 走这里）
~/Library/Logs/灵图/sidecar.log    # 路径取决于打包方式；当前 dev 模式直接输出到启动终端
```

---

## 2. 图片素材库维护

### 场景 A：批量加新原图（最常见）

**地点**：本地 macOS 桌面端 → 资产中心。

1. 把新图按景区文件夹放到 `~/lintu-data/workspace/<项目名>/<子文件夹>/`
2. 桌面端 → 资产中心 → 选项目 → 「扫描素材库」
3. sidecar 自动跑 pipeline：
   - **scan**：识别新文件，写 `images` 表
   - **dedup**：phash + CLIP 找重复
   - **quality**：blur_score + 亮度（不达标自动 reject）
   - **orient**：EXIF 自动旋转，AI 检测倒置
   - **tag**：调 doubao vision LLM 出 tags
   - **embed**：生成 1024d / 2048d embedding（仅当未生成时）
   - **oss_upload**：传到阿里云 OSS（含原图 + 缩略图）
4. 每张原图同步完成 → 自动 enqueue 推送云端（`cloud_sync_worker` 30s tick）

**怎么知道完成了**：桌面端"任务中心"看进度条。所有任务 status=done 即完成。

### 场景 B：手动加单张图（少见）
直接拖进资产中心；走同样的 pipeline。

### 场景 C：删除图片
桌面端 → 资产中心 → 选中 → 删除。本地软删 + enqueue 云端硬删（推 `/internal/sync/deletes`）。

### 场景 D：替换图片（保留 ID）
当前不支持原地替换。临时方案：删旧图 → 加新图（注意 UGC 已发布的链接会失效）。后续可以加替换 API。

### 数据健康巡检（每周一次）
```bash
# 在本地 sidecar
sqlite3 ~/lintu-data/lintu.db <<SQL
SELECT
  p.name, i.source_type,
  COUNT(*) AS total,
  SUM(CASE WHEN i.embedding IS NOT NULL THEN 1 ELSE 0 END) AS with_emb,
  SUM(CASE WHEN i.cdn_path IS NOT NULL THEN 1 ELSE 0 END) AS on_cdn,
  SUM(CASE WHEN i.tag_status = 'done' THEN 1 ELSE 0 END) AS tagged
FROM images i LEFT JOIN projects p ON p.id = i.project_id
GROUP BY p.name, i.source_type
ORDER BY p.name, i.source_type;
SQL
```

如果 `with_emb < total` → [Embedding](#4-embedding-向量化) 章节补跑；
如果 `on_cdn < total` → 跑「重新 OSS 同步」任务；
如果 `tagged < total` → 跑 tag 任务。

---

## 3. 标签体系与同义词

### 标签 Schema
- 所有维度 + 候选值在桌面端「设置 → 标签 Schema」可改
- 每次保存自动同步到 `~/lintu-data/tag_schema.json`，`cloud_sync_worker` 自动推到云端

**改完什么图会被影响**：
- 已 tagged 的图：保留旧 tag 不动
- 新 tagged 的图：用新 schema 出 tag
- 想全量重打：在「任务中心」批量重跑 `tag` 任务（耗 doubao API 配额，慎用）

### 同义词（match 用）
- 桌面端「匹配实验室 → 同义词」里维护
- 例：`"小朋友" → "儿童"` — UGC 写"小朋友"时云端按"儿童"标签也能召回
- 文件位置：`~/lintu-data/synonyms.json`，cloud_sync_worker 自动同步

### 添加新维度（如新增 facility 或 mood）
1. 桌面端「标签 Schema」加新维度 + 候选值
2. 重跑相关图的 tag 任务
3. 同步到云端会自动带过去

---

## 4. Embedding 向量化

### 默认 provider
- 本地配置：「设置 → AI 服务商 → image embedding」
- 当前用：`relay:ark-embedding` (doubao-embedding-vision-251215)，2048d
- 云端通过 bulk script + `cloud_sync_worker` 同步同款 provider 配置（**不含 OSS 写凭据，read-only 模式**）

### 何时需要重新 embed
- 切换 embedding model（dim 会变 → 必须全量重 embed）
- 检测发现某项目 `with_emb < total`（embed 任务断点续跑）
- 一批图 embedding 失败（看任务中心 status=failed）

### 如何触发 embed 任务

**桌面端**：
- 资产中心 → 选项目 → 「重新 embed」按钮

**或 API**（更精确控制）：
```bash
# 给单个项目补 embedding（自动跳过已 embed 的）
curl -s -X POST http://127.0.0.1:7879/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"project_id":"<PROJECT_ID>","type":"embed","parameters":{}}'

# 强制全量重 embed（force=true，慎用，耗 API 配额）
curl -s -X POST http://127.0.0.1:7879/api/tasks \
  -d '{"project_id":"<PROJECT_ID>","type":"embed","parameters":{"force":true}}'
```

### 性能参数
- 单任务内并发：`apps/sidecar/sidecar/engines/clip_embed.py:47` `API_CONCURRENCY=16`
- 同时跑的任务数：env `LINTU_API_CONCURRENCY=8`（默认）
- 实测吞吐：doubao Ark 服务端限 ~1 RPS，1027 张图约 18 分钟

### embed 后必须 push 到云端才生效
- 一般通过 `cloud_sync_worker` 自动推（image 写库时 enqueue）
- 大批量 embed 后建议一次性 bulk 同步：
  ```bash
  cd /Users/yang/projects/lintu/apps/sidecar
  uv run python scripts/sync_to_cloud_bulk.py
  ```

### ⚠️ 常见坑
- **不要手动往云端 PG 插测试 embedding**（dim 不一致会污染 shard，详见 commit 7919df6）。如果不小心插了 → `DELETE FROM images WHERE embedding_model='test'` + 重启 `lintu-sidecar` 容器。

---

## 5. 项目（景区）管理

### 添加新景区
1. 本地桌面端 → 项目管理 → 新建项目
2. 设 originals_path（本地源目录）+ workspace_path
3. 把新景区的原图放进 originals_path
4. 触发完整 pipeline（scan → dedup → quality → orient → tag → embed → oss_upload）
5. 30s 内 cloud_sync_worker 把新项目 + 图片自动推到云端
6. UGC 调匹配时传 `scope.primary_project_id=<新项目 ID>` 即可

### 删除项目
桌面端「项目管理 → 删除」。本地软删 + 云端硬删。**注意**：会丢失该项目所有图、tag、embedding，UGC 已发布的链接全失效。

### 重命名 / 改色
桌面端「项目管理 → 编辑」。属性变更走 `cloud_sync_worker` 自动推。

### 当前两个项目 ID
| 名称 | ID |
|---|---|
| 示例景区A | `00000000-0000-0000-0000-aaaaaaaaaaaa` |
| 示例景区B | `00000000-0000-0000-0000-bbbbbbbbbbbb` |

---

## 6. ApiKey 与 UGC 对接

### 给新对接方发 key
1. 桌面端「分发中心 → API Keys → 新建」
2. 填：
   - 名称：对接方业务名
   - client_type：`server`（推荐，UGC 后端代理调用）或 `client`（直接给前端，不安全慎用）
   - scopes：通常 `images:read,images:match,tags:read`；写权限 `images:write,generate:write` 仅特殊场景
   - 限流：per_minute / per_day（按对接方 SLA 设）
   - allowed_origins：前端域名白名单（CORS）
   - allowed_ips：来源 IP 白名单（可选）
3. 创建后**立即复制弹窗里的 secret**，仅显示一次
4. 完整 Bearer token = `<key_id>.<secret>`，即 `lk_live_xxx.yyy` 格式

### 停用 / 撤销 key
桌面端「分发中心 → API Keys → 停用」。立即生效，5s 内云端会拒绝该 key。

### 监控调用量
桌面端「分发中心 → 调用日志」按 key 查每天/每分钟调用量、错误率。

### 限流被触发的表现
UGC 调匹配返回 HTTP 429。建议对接方实现指数退避重试。

---

## 7. 同步到云端

### 自动增量（默认）
本地任何写操作都会 enqueue 到 `cloud_sync_jobs` 表，`cloud_sync_worker` 30s tick 推送。

**触发条件**：
- 新增/更新/删除 image、project、api_key
- 改 synonyms 或 tag_schema
- 改 config（embedding provider 等 — 见 `_CLOUD_RELEVANT_KEYS`）

**怎么知道推送状态**：
```bash
sqlite3 ~/lintu-data/lintu.db "SELECT status, COUNT(*) FROM cloud_sync_jobs GROUP BY status;"
```
应该看到 `done` 数远多于 `pending`/`failed`。`failed` 行可以重试：
```bash
sqlite3 ~/lintu-data/lintu.db "UPDATE cloud_sync_jobs SET status='pending', attempts=0 WHERE status='failed';"
```

### 全量回填（rare）
适用：云端是新建 PG / 怀疑数据漂移 / 切换了 embedding model 全量重 embed 后。

```bash
cd /Users/yang/projects/lintu/apps/sidecar
LINTU_CLOUD_SYNC_URL=https://api.example.com \
LINTU_INTERNAL_SYNC_TOKEN=<launchctl getenv LINTU_INTERNAL_SYNC_TOKEN> \
  uv run python scripts/sync_to_cloud_bulk.py
```

bulk script 推送顺序：config → projects → api-keys → synonyms → tag-schema → images（含 tags + embedding）。Idempotent，断了直接重跑。

### Cloud sync 启用前置
本地 macOS 必须设两个 env（已经通过 `~/Library/LaunchAgents/com.lintu.env.plist` 持久化）：
- `LINTU_CLOUD_SYNC_URL=https://api.example.com`
- `LINTU_INTERNAL_SYNC_TOKEN=<64 字符 hex,与云端 .env 一致>`

验证启用：
```bash
# Electron 启动后看本地日志
grep cloud_sync_worker ~/Library/Logs/灵图/sidecar.log | tail -3
# 期望: cloud_sync_worker: started → https://api.example.com
```

### Shadowrocket / 代理设置
本地访问 `api.example.com` 必须走直连，否则 SSL 握手会被代理破坏。在 Shadowrocket 加规则：
```
DOMAIN-SUFFIX,example.com,DIRECT
IP-CIDR,192.0.2.1/32,DIRECT,no-resolve
```

---

## 8. 升级与发布

### 开发流程（标准）
1. 本地 macOS 上改代码
2. `git commit` + `git push origin v0.2`
3. SSH 到 ECS：
   ```bash
   ssh lintu@192.0.2.1
   cd /srv/lintu
   git pull --ff-only
   docker compose -f deploy/docker-compose.parasitic.yml up -d --build
   docker compose -f deploy/docker-compose.parasitic.yml logs -f sidecar   # 看启动 + alembic
   ```
4. 等 healthcheck 转 healthy（30-60s）
5. smoke test：`curl https://api.example.com/health` 200

### Schema 迁移
新加表 / 加列 → 必须写 alembic migration（在 `apps/sidecar/alembic/versions/`）。容器启动时会自动 `upgrade head`。

### 重启 sidecar 容器
```bash
ssh lintu@192.0.2.1 'docker restart lintu-sidecar'
# 等 30-60s 健康
```

### 回滚
```bash
ssh lintu@192.0.2.1
cd /srv/lintu
git log --oneline -10        # 找上一个稳定 commit
git checkout <commit>
docker compose -f deploy/docker-compose.parasitic.yml up -d --build
```

如果 schema 迁移已经 apply（不可逆），需要手动 alembic downgrade — 一般 PR 时就避免破坏性 schema 变更。

### 紧急修复（hotfix）
1. 本地一个小 commit
2. push
3. ECS pull + rebuild
4. 整体 < 5 分钟

---

## 9. 备份与灾难恢复

### 云端 PG 备份
**每天凌晨 3 点自动**（建议加 cron）：
```bash
# 在 ECS 上以 lintu 用户跑：crontab -e 加这行
0 3 * * * mkdir -p /srv/lintu/backups && PGPASSWORD=$(cat ~/.lintu_db_password) pg_dump -h 127.0.0.1 -U lintu lintu | gzip > /srv/lintu/backups/pg-$(date +\%F).sql.gz
```
（如果你 host 上没装 pg_dump，可在容器内 `docker exec lintu-sidecar pg_dump ...`，但 sidecar 镜像默认没装 pg client；推荐让 ECS 装个 `postgresql-client`）

### 备份保留策略
- 保留最近 30 天每日备份
- 每月 1 日的备份 scp 到本地或 OSS 冷存储

### 本地 SQLite 备份
- `~/lintu-data/lintu.db` 是单文件 — 复制即可
- 建议 macOS Time Machine 自动覆盖该目录

### OSS 图片
- 阿里云 OSS 控制台已经有版本控制（如果开了）
- bucket `your-bucket` 设公网读但不可写（除桌面端的 access key 之外）

### 恢复演练
```bash
# 1. 新 ECS 上拉代码 + git pull
# 2. host PG 上新建 lintu 用户 + lintu 数据库 + 5 个 extension（参考 phase 4 init.sql）
# 3. 恢复备份：
#    gunzip < pg-2026-XX-XX.sql.gz | psql -h 127.0.0.1 -U lintu lintu
# 4. 启动 sidecar 容器，alembic 检查 schema 版本一致
# 5. 测试 /health + /open-api/v1/images/match
```

---

## 10. 性能调优

### 当前基准（warm）
- `/open-api/v1/images/match` 平均 ~1.6s（含 doubao Ark embedding API 1-1.5s）
- 5 次 bench p50 ≈ p95 ≈ 1.6s（稳定）

### 可调参数
| 位置 | 参数 | 默认 | 影响 |
|---|---|---|---|
| `apps/sidecar/sidecar/engines/clip_embed.py:47` | `API_CONCURRENCY` | 16 | 单 embed 任务内并发 API 调用 |
| `apps/sidecar/sidecar/scheduler/engine.py` env | `LINTU_API_CONCURRENCY` | 8 | scheduler 同时跑几个 API 类型任务 |
| `apps/sidecar/sidecar/scheduler/engine.py` env | `LINTU_CPU_CONCURRENCY` | 3 | 同时跑几个 CPU 任务（dedup / quality） |
| `apps/sidecar/sidecar/engines/query_expansion.py` 参数 | `timeout_sec` | 1.5s | LLM 扩展超时（短=快但 recall 略差） |
| `apps/sidecar/sidecar/engines/match_strategy.py` | `_PRIMARY_FLOOR_RATIO` | 1.0 | 主项目独占 limit；改 0.75 允许跨景区 |
| `apps/sidecar/sidecar/engines/match_strategy.py` | `_NOISE_FLOOR` | 0.30 | 项目召回信号阈值；调高=更严 |

### 后续优化备选（按收益排序）
1. **响应级 LRU 缓存**：相同 (text + filters) 30s 内直接返回 cached → < 50ms
2. **embedding LRU 缓存**：相同 text 复用向量 → 节省 1-1.5s 主瓶颈
3. **截断长文本**：embed 前截前 200 字 → 估计省 300-500ms
4. **PGVector HNSW 索引**：如果未来图量到 100k+，把 in-memory matrix 切成 PG 索引

---

## 11. 开发与本地调试

### 启动本地（开发模式）
```bash
# Vite dev server (前端 hot reload)
cd /Users/yang/projects/lintu/apps/electron
npx vite --config vite.config.ts &

# Electron（自动拉起本地 sidecar 在 7879）
LINTU_CLOUD_SYNC_URL=https://api.example.com \
LINTU_INTERNAL_SYNC_TOKEN=<token> \
  npx electron .
```

### 单独启动 sidecar（不要 Electron）
```bash
cd /Users/yang/projects/lintu/apps/sidecar
uv run uvicorn sidecar.main:app --port 7879 --host 127.0.0.1
```

### 装本地 CLIP fallback（可选 — 默认不装节省 1.5GB 依赖）
```bash
cd /Users/yang/projects/lintu/apps/sidecar
uv sync --extra local-clip
```

### 调试匹配策略
桌面端「匹配实验室 → 试匹配」是最方便的调试 UI；可调权重、看 debug 字段、对比策略。

云端有同款：`https://api.example.com/demo/`

### 调试 bulk push
```bash
cd /Users/yang/projects/lintu/apps/sidecar
PYTHONUNBUFFERED=1 \
LINTU_CLOUD_SYNC_URL=... \
LINTU_INTERNAL_SYNC_TOKEN=... \
  uv run python scripts/sync_to_cloud_bulk.py
```

### Git 工作流
- 长寿命分支：`v0.2`
- 每次小改动一个 commit；commit message 写「为什么」而非「改了什么」
- 推送：`git push origin v0.2`
- ECS 上 `git pull --ff-only`（永远 fast-forward，不要 merge）

### 改云端配置不重启容器
```bash
# 推 settings 子集
TOKEN=<LINTU_INTERNAL_SYNC_TOKEN>
curl -X POST https://api.example.com/internal/sync/config \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settings":{"match_max_limit":50}}'
```
但下次容器重启会以 config.json 文件为准 — 持久化变更建议在桌面端「设置」改后让 cloud_sync_worker 自动同步。

---

## 12. 故障排查速查

| 症状 | 检查 | 修复 |
|---|---|---|
| `/health` 返回 502 | sidecar 容器 down | `docker ps -a` 看状态；`docker logs lintu-sidecar` 看启动错误；多半 alembic 迁移卡 |
| 容器一直 restarting | host PG 无法连 | `psql -h 127.0.0.1 -U lintu -d lintu` 测连通；检查 .env 里 LINTU_DB_URL |
| UGC 调 match 401 | Bearer token 错 / 已停用 / 同步未到云端 | 桌面端 → 分发中心确认 key 状态；查云端 PG `SELECT * FROM api_keys WHERE key_id='...'` |
| UGC 调 match 403 | scope 不够 / origin 不在白名单 | 桌面端 → key 详情看 scopes 和 allowed_origins |
| UGC 调 match 429 | 限流 | 提升该 key 的 per_minute/per_day，或让对接方加退避 |
| match 返回 0 张 | filter 太严 / 文案没命中标签 / 主项目 shard 空 | 看 debug 字段：`recall_emb`+`recall_kw` 召回数；`scope_decision.raw_signals` 是否包含主项目 |
| match 返回的图全是错项目 | shard dim 污染（脏数据） / scope quota 没到主项目 | 查云端 PG `SELECT embedding_model, COUNT(*) FROM images WHERE embedding IS NOT NULL GROUP BY embedding_model;` 看是否多种 dim 混合；清理脏数据 + 重启容器 |
| 图片 URL 404 | `cdn_path` 缺失 / OSS 配置丢 | 查云端 config.json 里 `oss_bucket` `oss_endpoint`；确认本地图已走 `oss_upload` 任务 |
| `cloud_sync_worker: disabled` | env 没传给 Electron | launchctl plist 没加载；从 GUI 启动 Electron 而非终端 |
| 本地改图后云端未变 | sync_worker 没运行 / 失败 | 查 `cloud_sync_jobs` 表 status 字段；重启 Electron |
| Push 到 GitHub 失败 SSL bad record mac | Shadowrocket 干扰 | 用 SSH 协议 (`git@github.com:...`) 替代 HTTPS；或加 GitHub.com 直连规则 |
| Build sidecar Docker 卡在 apt | 国内访问 deb.debian.org 慢 | Dockerfile 已配 aliyun + 清华源，确认未被改回 |
| Build 卡在 uv sync 拉 torch | 装了 local-clip extra | 默认 `uv sync` 不带 extra，确认 Dockerfile 里 RUN uv sync 没有 `--all-extras` |

---

## 附：关键 commit 锚点

| 主题 | Commit | 说明 |
|---|---|---|
| Cloud sync 基础 | `c2e8b12` | worker / router / migration / bulk script |
| 双景区匹配放宽 | `e7b525c` | per-project recall 200 + primary 独占 limit |
| 寄生部署 compose | `d53ffab` | host network + 17879 |
| 复用 host PG | `a32ab07` | 删独立 PG 容器 |
| Cloud-only deps | `2df25a8` | China mirror + torch 移到 optional |
| Embed 并发 5 → 16 | `e180157` | API 并发提升 |
| API 文档 | `01a700a` | UGC OpenAPI guide |
| OSS read-only 部署 | `142545b` | 云端不需要 OSS 写凭据 |
| Shard 加固 | `7919df6` | 多数派 dim 防脏数据污染 |
| 延迟优化 | `d10586a` | expand 1.5s timeout + 并行 recall |

完整 commit log: `git log --oneline origin/v0.2`

---

## 附：联系 / 反馈

- 代码 issue：在 GitHub repo `Estrella9527/lintu` 提
- 紧急事故：联系运营 / 后端 owner
- 安全事件（密钥泄漏 / 异常调用）：立即停用相关 ApiKey + 轮换 `LINTU_INTERNAL_SYNC_TOKEN`
