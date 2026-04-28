# 灵图 Lintu · 对外 UGC Open API 产品方案 (S5 PRD)

| 字段 | 值 |
|---|---|
| 文档版本 | v1.0 |
| 起草日期 | 2026-04-25 |
| 责任阶段 | S5 — 对外服务化 |
| 状态 | 待评审 / 准备进入开发 |

---

## 0. 一句话总结

> 让外部 UGC（用户生成内容）应用能用一个 HTTP API Key，**输入文本**就拿到**多张配图 + CDN URL**，<200ms 首图加载，端到端可控。

---

## 1. 背景与问题

### 1.1 现状
灵图当前作为**单机创作工具**完成「拍摄 → 清洗 → 打标 → AI 生成」全链路，沉淀了：
- 高质量原图库（带 6 维度结构化标签：场景/季节/天气/角度/人物/设施）
- 生成图谱（每张 AI 图都有 prompt + seed + provider 元数据）
- CLIP 图像 embedding（512 维 / 1024 维）
- 已上架的 Open API v1（带 Bearer 认证 + audit log，但功能限于"列表 / 详情"）

### 1.2 痛点
1. 外部 UGC 应用要发**图文内容**，"图"全靠人工挑，没办法用我们的 API 智能匹配
2. 现有 Open API 只暴露元数据，**图片字节走本地 sidecar**，外网不可达
3. API Key 的 scope / rate-limit 字段定义了但**未强制**，无法对外开放给陌生客户端
4. 无 CDN，外部访问 → 本地 sidecar 转发 → 性能差且依赖 Electron 在线

### 1.3 目标用户
- **直接客户**：景区运营方的小程序 / H5 / 公众号 / 抖音号 / 内部 CMS
- **典型流程**：UGC 应用调大模型 → 生成文案 → 调灵图 API → 拿到 N 张配图 → 用户挑 1-3 张发布

---

## 2. 核心用户故事

### Story 1：图文匹配单次调用（高频）
> 作为 UGC 应用后端，我用 generated_text 调用一个端点，**一次返回 5-10 张候选图（按相关性排序）**，每张都有公网 CDN URL、缩略图 URL、相关性分数和命中维度。我的应用直接展示给用户挑选。

### Story 2：约束式匹配（中频）
> 我希望文图匹配能加约束，比如「只要冬季的山地景观」「排除有人物的图」，在 API 入参里就能指定。

### Story 3：稳定快速（基础设施需求）
> 我从全国任意位置发请求，**P95 < 500ms 拿到 ranked list**，**首图 P95 < 800ms** 在浏览器渲染。不能因为创作端 Electron 关掉就服务挂掉。

### Story 4：可观测可控（运营需求）
> 我作为景区运营方能看到：每个 API Key 调了多少次、命中了哪些图、哪些文本没匹配上、平均相关性，决定要不要补图。

---

## 3. 功能拆解（三大模块）

### M1 · Open API 加固
让 v1 端点真正可对外开放。

#### M1.1 认证与限流
- 现有 ApiKey 模型字段（scopes/rate_limit/quota）**强制生效**
- Scope 粒度：`images:read`, `images:match`, `images:download`, `tags:read`, `stats:read`
- Rate-limit：sliding-window in-memory（单实例 OK；多实例后续切 Redis）
- Quota：日额度 + 月额度，超出 429
- 错误格式标准化：`{ error: { code, message, request_id } }`

#### M1.2 新增端点
- **`POST /open-api/v1/images/match`** ← 核心：文图匹配（M2 实现）
- `POST /open-api/v1/images/{id}/track-usage` ← UGC 反馈被使用了（精排回流）
- `GET /open-api/v1/images/{id}/cdn-url` ← 单张拿 CDN URL（含签名/过期）

#### M1.3 文档与 SDK
- OpenAPI 3.0 schema 自动生成 + Swagger UI（FastAPI 原生）
- 公开站点托管 / 拷贝到客户邮箱（先后者，简单）
- 提供 curl + JS + Python 示例

### M2 · 文图匹配能力
端到端"text → ranked images"。

#### M2.1 索引层（建一次，长存）
- **Image embedding**：已有（CLIP 512d 或 Ark vision 1024d）
- **Tag 信号**：已有（6 维度 30+ 值）
- **Description 信号**：已有 `Image.description`（生成图）/ AI 打标产物（原图）
- **新增持久化字段**：
  - `image.text_search_blob`：拼接 description + tags + filename，全文检索 fallback
  - `image.embedding_text`（可选）：基于 description+tags 计算的"图片侧文本 embedding"，让 text↔text 召回更准

#### M2.2 召回层（粗筛）
两路混合召回，结果 union：

**召回 A · 跨模态 embedding 召回**
- 输入文本 → text embedding（**新增**：调 Ark text embedding 或本地 sentence-transformers）
- 与 `image.embedding`（CLIP/Ark vision）做 cosine similarity
- 限制：CLIP 是真跨模态可直接用；Ark vision-embedding 是否兼容 text 待验证
- Top-K = 200

**召回 B · Tag/关键词召回**
- 输入文本 → 关键词抽取（中文分词 jieba + 自定义词典基于 tag schema 30+ 值）
- 命中的 tag value → 召回该维度匹配的图
- Top-K = 200

#### M2.3 精排层
合并候选 ∪（最多 ~400 张），按以下加权：

| 信号 | 默认权重 | 说明 |
|---|---|---|
| Embedding 相似度 | 0.45 | 跨模态相关性主信号 |
| Tag 命中度 | 0.30 | 命中维度数 / 关键词数 |
| 图片质量分 | 0.10 | blur_score 归一化 |
| 多样性惩罚 | 0.10 | 已选 top-K 的种子图重复扣分 |
| 业务规则 | 0.05 | 例如 source_type=original 优先 / 同一 dedup_group 只取一张 |

权重写在配置 `match_strategy_weights`，可调；后续支持每个 API Key 不同策略。

#### M2.4 反馈回流
- `track-usage` 端点记录 (text_hash, image_id, was_chosen) 到 `match_feedback` 表
- 后续 v1.1 用反馈数据调权重 / fine-tune

#### M2.5 API 形状

```http
POST /open-api/v1/images/match
Authorization: Bearer lk_live_xxx.<secret>
Content-Type: application/json

{
  "text": "周末带孩子来这里玩了一天，秋天的山地特别美，孩子在小火车上笑得停不下来",
  "limit": 8,
  "filters": {
    "scene": ["山地景观", "森林步道"],
    "season": ["秋"],
    "people": ["有人"],
    "exclude_tags": { "weather": ["雨"] },
    "source_type": "original"
  },
  "diversity": "balanced"   // strict | balanced | none
}
```

```json
{
  "request_id": "req_20260425_xyz",
  "matches": [
    {
      "image_id": "abc123",
      "score": 0.87,
      "score_breakdown": { "embedding": 0.72, "tag": 0.95, "quality": 0.61 },
      "matched_tags": [
        { "dimension": "scene", "value": "山地景观" },
        { "dimension": "season", "value": "秋" }
      ],
      "url": "https://cdn.lintu.com/i/abc123.jpg",
      "thumbnail_url": "https://cdn.lintu.com/i/abc123_800.jpg",
      "width": 4096,
      "height": 2730,
      "tags": { ... },
      "description": "..."
    }
  ],
  "took_ms": 247
}
```

---

### M3 · 图片快速分发
解决"外网怎么拿到图"。

#### M3.1 部署架构（推荐方案：CDN + Server 模式）

```
┌─────────────────────────────────────────────────────┐
│  Electron (本地创作端)                              │
│   ↓ 上传/生成新图                                    │
│  Sidecar (LINTU_MODE=electron)                      │
│   ↓ 异步 OSS 同步任务                                │
│   ↓ 生成图也走同一通道                              │
└────────────┬────────────────────────────────────────┘
             │
             ▼
       OSS (阿里云 / 腾讯 COS / 七牛)
       ├── originals/{id}.{ext}
       ├── thumbnails/800/{id}.jpg
       └── thumbnails/300/{id}.jpg
             │
             ▼
       CDN (cdn.lintu.com)  ← UGC 应用直接拉
             ▲
             │
       ┌─────┴─────────────────────────────────────┐
       │  Lintu API Gateway (Docker, 公网)          │
       │  Sidecar (LINTU_MODE=server)               │
       │  - 复用同一份 lintu.db (备份/复制)          │
       │  - 处理 /open-api/v1/* 请求                 │
       │  - 返回的 URL 都指向 CDN                    │
       └────────────────────────────────────────────┘
```

#### M3.2 OSS 双写方案
- 新增 `engines/oss_sync.py`：抽象 ObjectStorage 接口（先实现阿里云 OSS）
- 触发点：
  - `scan` 完成后，新图入库后异步推送
  - `batch_engine._run_subtask` 成功后，生成图入库后异步推送
  - `thumbnail.generate_thumbnail` 完成后，缩略图也推送
- 数据库字段新增：`Image.cdn_path`（nullable，写入后才有）
- 失败重试：失败队列表 `oss_sync_jobs`，定时 worker 重试

#### M3.3 CDN URL 规则
- 原图：`https://cdn.lintu.com/i/{id}.{ext}`
- 缩略图：`https://cdn.lintu.com/i/{id}_{size}.jpg`（size ∈ 300|800）
- **签名 URL（可选）**：通过 OSS 签名链接限制有效期，防盗链

#### M3.4 数据同步策略
两种模式可选：
- **A. 单 DB 双进程**（先做）：本地 Electron 和云端 server 共享同一份 SQLite，通过 SQLite 的 WAL 同步（适合冷启动 / 创作端不常用时）
- **B. 主从复制**：本地写 → 推 SQL 到云端 server（最终一致性，适合多人同时创作）

S5 阶段先做 A，有需要再升 B。

---

## 4. 数据模型变更

### 4.1 新增字段（migrations）
```sql
-- Image
ALTER TABLE images ADD COLUMN cdn_path TEXT;                 -- M3
ALTER TABLE images ADD COLUMN text_search_blob TEXT;         -- M2.1
ALTER TABLE images ADD COLUMN embedding_text TEXT;           -- M2.1 (可选)

-- ApiKey: 利用现有字段，无 schema 改动
```

### 4.2 新表
```sql
-- M2.4 反馈回流
CREATE TABLE match_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  api_key_id TEXT,
  query_text TEXT,
  query_text_hash TEXT INDEX,
  matched_image_id TEXT,
  rank INTEGER,
  score REAL,
  was_chosen BOOLEAN DEFAULT 0,
  created_at DATETIME
);

-- M3.2 OSS 同步任务队列
CREATE TABLE oss_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id TEXT INDEX,
  asset_kind TEXT,           -- 'original' | 'thumb_300' | 'thumb_800'
  status TEXT DEFAULT 'pending',  -- pending | running | done | failed
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at DATETIME,
  completed_at DATETIME
);

-- M1.1 quota 实际使用账单
CREATE TABLE api_key_usage_daily (
  api_key_id TEXT,
  date TEXT,                 -- YYYY-MM-DD
  count INTEGER DEFAULT 0,
  cost_estimate_usd REAL,
  PRIMARY KEY (api_key_id, date)
);
```

---

## 5. 配置项新增

```python
# defaults.py
"oss_provider": "",                      # "aliyun" | "tencent" | "qiniu" | ""(disabled)
"oss_endpoint": "",                      # e.g. "oss-cn-hangzhou.aliyuncs.com"
"oss_bucket": "",
"oss_access_key": "",                    # secret-masked
"oss_access_secret": "",                 # secret-masked
"oss_cdn_base": "",                      # "https://cdn.lintu.com"
"oss_signed_url_ttl_sec": 0,             # 0 = 不签名，公开访问

"text_embedding_provider": "",           # "" = local sentence-transformers, or "relay:<name>"
"text_embedding_model": "",

"match_strategy_weights": {
  "embedding": 0.45,
  "tag": 0.30,
  "quality": 0.10,
  "diversity": 0.10,
  "business_rules": 0.05,
},
"match_default_limit": 8,
"match_max_limit": 50,
```

---

## 6. 部署形态

### 6.1 开发期（本地）
- Electron 本地跑（创作）
- Sidecar `LINTU_MODE=electron` (port 7879)
- 测试用 `LINTU_MODE=server` 临时跑在另一个端口模拟外部调用

### 6.2 生产期（推荐最小可行）
- 一台云主机 / 一个 Docker 容器：`docker run lintu-server LINTU_MODE=server`
- Nginx 反向代理 + Let's Encrypt TLS
- 数据库：先用 SQLite 文件挂载 volume；流量上来切 PostgreSQL
- OSS：阿里云 OSS（用户已用 Volcengine Ark，技术栈接近）
- CDN：阿里云 CDN 回源到 OSS

### 6.3 升级路径
| 阶段 | 容量 | 形态 |
|---|---|---|
| MVP | < 1 万 QPD | 单 Docker + SQLite + OSS |
| Scale 1 | 10 万 QPD | 单 Docker + PostgreSQL + Redis (rate-limit) + OSS |
| Scale 2 | 100 万 QPD | k8s 多副本 + PostgreSQL + Redis + Faiss/Qdrant 索引 |

---

## 7. 落地里程碑（S5 拆分）

| 里程碑 | 工时 | 关键交付 |
|---|---|---|
| **S5.1** API 加固 | 3-4 天 | scope/rate-limit/quota 中间件强制；统一错误格式；Swagger 自动生成 |
| **S5.2** OSS 双写 | 4-5 天 | oss_sync 引擎（阿里云）；scan/batch/thumbnail 推送钩子；Image.cdn_path；UI 在 DistributionCenter 配置 |
| **S5.3** 文图匹配 | 5-7 天 | text embedding 接入；index_text_blob 回填；match 端点；filter + diversity；测试 30 条文本 |
| **S5.4** 反馈与可观测 | 2-3 天 | track-usage / match_feedback 表；DistributionCenter 增加"调用统计 / 命中分析"页 |
| **S5.5** 部署与压测 | 3-4 天 | Docker 镜像 + Nginx + TLS；100 QPS 压测；客户接入文档 |

**合计 17-23 工作日 (~3 周)**

---

## 8. 关键决策点（需要你拍板）

### D1 · Text embedding 选型
- **选项 A**：Ark `doubao-embedding`（你已有 Ark Key，国内快）
- **选项 B**：本地 `sentence-transformers`（免费，但需安装 ~500MB 模型）
- **选项 C**：OpenAI `text-embedding-3-small`（最便宜，质量好，但需海外）
- **推荐 A**：和 image embedding 同一供应商，账单统一

### D2 · OSS 选型
- **选项 A**：阿里云 OSS + 阿里云 CDN（国内主流，文档全）
- **选项 B**：腾讯云 COS
- **选项 C**：七牛云（小流量便宜）
- **推荐 A**

### D3 · 部署 server 节点放哪
- **选项 A**：阿里云 ECS / 轻量服务器（自管，省钱）
- **选项 B**：阿里云函数计算 / 容器服务（弹性，省运维）
- **选项 C**：用户自建 / 云端二选一（看后续客户）
- **暂定 A**

### D4 · 数据库
- 先用 SQLite + 卷挂载（已经够 1 万 QPD），不引入 PostgreSQL
- 当 server 端有写入需求时（如 match_feedback）会和创作端 SQLite 冲突 → 提前用主从或者 server 端独立 DB（写 feedback）+ 同步原图元数据

### D5 · 知识库扩展（开放问题）
你提到"现有景区内容知识库"——目前 Lintu 只有图片 + tags，没有结构化"景区简介 / 景点介绍"实体。这部分是否：
- (i) 由 UGC 应用自己维护（灵图只管图）→ **本方案默认这条**
- (ii) 灵图也要承载文本知识库（新模型 ScenicSpot + 文档解析）→ 需要再加 1 个里程碑

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Ark vision-embedding 不兼容 text 模式 | 跨模态召回失效 | 改 CLIP 本地（已部署）；或退化为 tag-only 召回 |
| OSS 推送失败导致 CDN URL 失效 | 外部用户拿到 404 | 失败队列 + 重试；fallback 到 sidecar /file 流式（紧急） |
| match 端点 200 张全量打分慢 | P95 超 500ms | 单图 embedding 矩阵预加载内存；超过 1 万图后切 sqlite-vec 或 Qdrant |
| API Key 泄露 | 被恶意刷量 | 强制 quota + IP 白名单 + 异常检测告警 |
| 单 SQLite 写竞争（创作端 + server 端 feedback） | DB 锁 | 短期：feedback 表独立 SQLite 文件；长期：上 PostgreSQL |
| 创作端不在线时新图未同步 | UGC 拿到旧库 | 双写设计就是为这个：图入库即推 OSS，云端 server 不依赖 Electron |

---

## 10. 验收标准

S5 完成后必须满足：
1. ✅ 一个外部 curl 用 API Key 能调通 `match` 端点
2. ✅ 返回的 URL 在 Postman / 浏览器可直接渲染（无需登录）
3. ✅ 同一 Key 超过 quota 返回 429
4. ✅ scope 不包含 `images:match` 时返回 403
5. ✅ 100 张图测试集 30 条不同文本，人工评估命中率 ≥ 70%
6. ✅ P95 < 500ms (北京到杭州 OSS / CDN 链路)
7. ✅ Electron 关闭后 server 端 API 仍可正常调用
8. ✅ 创作端新增图后 < 60s 出现在 OSS

---

## 附录 A · 推荐策略调权方法

匹配策略对不同业务场景敏感度不同，提供 3 个预设：

| 预设 | 适用 | embedding | tag | quality | diversity |
|---|---|---|---|---|---|
| `precise` | 严格匹配（专业 CMS） | 0.55 | 0.35 | 0.05 | 0.05 |
| `balanced` (默认) | 通用 UGC | 0.45 | 0.30 | 0.10 | 0.10 |
| `diverse` | 浏览/灵感场景 | 0.30 | 0.20 | 0.15 | 0.30 |

入参 `strategy: "balanced"` 即选择预设；高级用户传 `weights: {...}` 覆盖。

---

## 附录 B · 现有可复用资产

- ✅ `routers/openapi_v1.py` — v1 端点骨架（list/detail/file）
- ✅ `routers/api_keys.py` — Key 管理 CRUD（缺中间件强制）
- ✅ `middleware/auth.py` — Bearer 解析（缺 scope/quota 校验）
- ✅ `engines/clip_embed.py` — image embedding（CLIP/Ark）
- ✅ `engines/dedup.py` — 余弦相似度计算（直接复用）
- ✅ `routers/tag_schema.py` — 6 维度结构化标签
- ✅ `LINTU_MODE=server` — 已支持公网模式
- ✅ Docker 部署脚本（S4.4 已交付）

---

**文档结束**
