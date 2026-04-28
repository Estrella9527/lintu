# 灵图 Open API v1 — 接入指南

面向第三方对接方（H5 / 小程序 / 服务端整合）。Base URL 形如 `https://your-domain.com/open-api/v1`。

## 1. 快速上手（30 秒）

```bash
export TOKEN="lk_live_xxx.your_secret"

# 健康检查（公开）
curl https://your-domain.com/open-api/v1/health

# 取前 5 张已通过质检的图
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-domain.com/open-api/v1/images?limit=5"
```

代码示例见 `examples/`：

| 文件 | 语言 | 说明 |
|------|------|------|
| `curl_examples.sh` | bash | 所有端点的 curl 模板 |
| `lintu_client.py` | Python 3 | 零依赖 SDK（stdlib `urllib`） |
| `lintu_client.js` | Node 18+ | 零依赖 SDK（内置 `fetch`） |

## 2. 部署模式

灵图同时支持两种运行模式，由环境变量 `LINTU_MODE` 决定：

| 模式 | 用途 | `/api/*` 管理路由 | `/open-api/*` 鉴权 |
|------|------|-------------------|--------------------|
| `electron` | 桌面端本机使用 | 开放 | **不强制**（本机进程通信） |
| `server`   | 公网部署 | **关闭** | **强制 Bearer** |

部署细节见 `deploy/README.md`。

## 3. 鉴权

### Bearer Token（当前唯一方案）

请求头：

```
Authorization: Bearer lk_live_xxx.<secret>
```

**Token 格式**：`<key_id>.<secret>`，两者用 `.` 分隔。

- `key_id` 公开值，类似 `lk_live_3e752eeabf4653d809cb5f41`
- `secret` 私密值，**只在创建/旋转 Key 时返回一次**，服务器只存 SHA-256 哈希

> **HMAC 签名**（PRD §5.3 推荐给纯静态 H5 的方案）暂未上线 — 需要先做加密 secret 仓库，规划在 v0.3。当前所有 Key 都通过 Bearer 验证。

### Key 在哪创建？

桌面端 Electron 应用 → **分发中心 → API Keys → 新建**。
弹窗会显示一次性的 Bearer Token，点「我已保存」之后无法找回，只能 rotate 重置。

服务器模式下 `/api/api-keys` 路由被禁用 — 必须先在桌面端创建好 Key，然后让服务器读同一个 SQLite。

### 浏览器/H5 该怎么接？

**不要把 secret 放进浏览器 JS 里**。即使是混淆过的 token 也容易被网络面板拿到。

正确接法：在 H5 自己的 BFF（Backend-For-Frontend）中持有 token，浏览器只调 BFF，BFF 再签名转发到灵图。Node SDK 示例（`lintu_client.js`）就是放在 BFF 里的。

## 4. 端点清单

所有路径都以 `/open-api/v1` 为前缀。

### 公开

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | 健康检查 |

### 图片

| Method | Path | Scope | 说明 |
|--------|------|-------|------|
| GET | `/images` | `images:read` | 列表（筛选、分页） |
| GET | `/images/{id}` | `images:read` | 单图详情 + 标签 |
| GET | `/images/{id}/derivatives` | `images:read` | 该图的所有衍生图 |
| GET | `/images/{id}/file` | `images:read` | 图片文件（原图或缩略图，`size=128/300/800`） |

`/images` 查询参数：`project_id` `source_type` `scene[]` `season[]` `offset`（默认 0）`limit`（默认 50，上限 200）。

### 标签 / 矩阵 / 统计

| Method | Path | Scope | 说明 |
|--------|------|-------|------|
| GET | `/tags` | `tags:read` | 标签维度的值分布 |
| GET | `/matrix` | `matrix:read` | 行×列覆盖矩阵 |
| GET | `/stats` | `stats:read` | 总数 / 通过 / 生成 / 已打标 |

### 批次

| Method | Path | Scope | 说明 |
|--------|------|-------|------|
| GET | `/batches` | `batches:read` | 批次列表 |
| GET | `/batches/{id}` | `batches:read` | 单批次详情 |
| POST | `/batches` | `generate:write` | 提交新批次（**对外通常不开此 scope**）|

`POST /batches` 请求体：

```json
{
  "project_id":  "xxx",
  "name":        "外部触发批次",
  "task_type":   "outpaint",
  "seed_image_ids": ["..."],
  "prompt_ids":     ["..."],
  "concurrency": 5,
  "max_retry":   3,
  "budget_usd":  1.5
}
```

> **Scope 检查**目前在中间件里只做了存在性，未做按 scope 的细粒度鉴权 — v0.2 是开放给信任 caller 用的。生产对接前请确保 Key 配置合理。

## 5. 错误模型

所有错误都返回标准 JSON：

```json
{ "error": "<code>", "detail": "<human-readable>" }
```

| HTTP | code | 含义 |
|------|------|------|
| 401 | `unauthorized` | Token 缺失 / 错误 / 过期 |
| 403 | `forbidden_origin` | 请求 Origin 不在 Key 的 `allowed_origins` |
| 403 | `forbidden_ip` | 请求 IP 不在 Key 的 `allowed_ips` |
| 404 | (FastAPI 默认) | 资源不存在 |
| 429 | `rate_limited` | 触发了 Key 的 per_minute / per_day |
| 500 | (FastAPI 默认) | 服务端异常（同时会写入审计日志） |

## 6. 限流

每个 Key 可在创建时配置：

```json
{
  "rate_limit": {
    "per_minute": 60,
    "per_day": 10000
  }
}
```

实现是单进程内存滑窗（`asyncio.Lock` + `deque`）。多副本部署需要换 Redis — v0.2 范围外。

## 7. CORS

服务器模式下浏览器请求会被 CORS 拦截。需要在容器启动时设：

```bash
LINTU_ALLOW_CORS=https://h5.example.com,*.partner.com
```

支持精确匹配和 `*.domain` 通配子域。

## 8. 审计日志

每个 `/open-api/*` 请求（无论成功失败）都会写入 `api_request_logs` 表，字段：

```
id, key_id, method, path, status_code,
ip, user_agent, response_size, latency_ms, created_at
```

桌面端 → **分发中心 → 调用日志** 可按 Key 查询，5 秒自动刷新。

> 默认**不**记录 request_body。需要时在容器侧设 `LINTU_AUDIT_BODY=1`，敏感字段（包含 `secret/password/token/api_key` 字样）会自动 `***` 脱敏。

## 9. SSE（流式进度）

灵图主链路里有几个 SSE 端点（**只在 electron 模式开放**），`server` 模式下未来会按需开放：

- `GET /api/batches/{id}/stream` — 批次实时进度
- `GET /api/prompt-docs/{id}/stream` — 文档解析阶段事件

格式参考 OpenAI 的 chat-completions stream：每行 `data: <JSON>\n\n`，连接关闭表示结束。25-30s 一个 `:keepalive\n\n` 注释保活。

## 10. 推荐对接姿势

1. **拿 Key**：桌面端创建一个 `client_type=h5` 的 Key，scope 给最小集（`images:read,tags:read`），`allowed_origins` 填 H5 域名，`per_minute=60 / per_day=10000`。
2. **放 BFF**：把 Bearer token 放在 H5 自己的 BFF 环境变量里。
3. **写代理**：BFF 暴露轻量端点给浏览器（如 `/api/poster?id=xxx`），转调灵图，缓存适当。
4. **图片直传**：高频图片访问可让灵图前面挂 nginx + 缓存，`/open-api/v1/images/{id}/file?size=300` 已带 `Cache-Control: max-age=86400`。
5. **错误兜底**：BFF 收到灵图 401/429，要给浏览器返回友好降级（占位图、缓存数据），别让用户看到原始 5xx。

## 11. 版本与兼容

- 当前版本：**v1**
- 路径里加 `/v1/`，未来非兼容变更会发 `/v2/`
- 旧路径 `/open-api/<x>`（不带 v1）作为兼容层保留 1 个 sprint，预计 v0.3 移除

## 12. 联系/反馈

- 桌面端 → **分发中心 → 接口文档** 可一键测试常用端点
- 调用问题先看 **调用日志** 找到对应 row 的 status_code 和 detail
- 仍不能定位时联系开发同学，附上 `key_id`（不要给 secret） + 请求时间
