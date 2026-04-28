# 灵图云端 OpenAPI 对接文档

> 面向 UGC / 第三方对接方。本文档由 `https://api.example.com/openapi.json` 自动生成。
> 想交互式调试请直接打开 [Swagger UI](https://api.example.com/docs) 或 [Redoc](https://api.example.com/redoc)。

---

## 基本信息

- **Base URL**: `https://api.example.com`
- **API 版本**: `v1`
- **协议**: HTTPS（HTTP/2，自动 redirect）
- **请求/响应**: JSON UTF-8

## 认证

每个 `/open-api/v1/*` 请求都需要 `Authorization: Bearer <token>` 头部。

Token 格式：`<key_id>.<secret>`，由灵图桌面端「分发中心 → API Keys → 新建」生成；secret 仅在创建时显示一次，请立即保存。

示例：
```bash
curl -H "Authorization: Bearer lk_live_xxx.your_secret" \
  https://api.example.com/open-api/v1/health
```

## 限流

每个 ApiKey 创建时设置 `per_minute` / `per_day` 配额。超额返回 HTTP 429。

## 错误码

| 码 | 含义 |
|---|---|
| 200 | 成功 |
| 401 | Bearer token 缺失/无效/已停用 |
| 403 | scope 不够（没有该端点权限）/ origin 不在白名单 |
| 429 | 触发 per_minute / per_day 限流 |
| 500 | 云端内部错误（请反馈 image_id 或 request_id 给运营）|

---

## 端点列表

### `GET /open-api/v1/batches`

**List Batches Public**

- 所需 scope: `generate:read`
- 参数:
  - `project_id` (query) — 
  - `status` (query) — 

---

### `POST /open-api/v1/batches`

**Submit Batch Public**

- 所需 scope: `generate:write`
- 请求体: `application/json`

Scope: generate:write — most H5 keys should not be granted this.

---

### `GET /open-api/v1/batches/{batch_id}`

**Get Batch Public**

- 所需 scope: `generate:read`
- 参数:
  - `batch_id` (path) (required) — 

---

### `GET /open-api/v1/health`

**Health**


---

### `GET /open-api/v1/images`

**List Images**

- 所需 scope: `images:read`
- 参数:
  - `project_id` (query) — 
  - `source_type` (query) — 
  - `scene` (query) — 
  - `season` (query) — 
  - `folder` (query) — 
  - `folder_prefix` (query) — 
  - `offset` (query) — 
  - `limit` (query) — 

---

### `POST /open-api/v1/images/match`

**Match Images**

- 所需 scope: `images:match`
- 请求体: `application/json`

Match a piece of text against the image library.

Returns up to `limit` images ranked by:
  - cross-modal embedding similarity (Ark vision, same space as text)
  - tag dimension hits extracted from the text via jieba + tag schema
  - blur quality, business rules, diversity

See match_strategy.STRATEGY_PRESETS for weight defaults; pass
`weights` to override per-call.

---

### `POST /open-api/v1/images/similar`

**Find Similar Images**

- 所需 scope: `images:match`
- 请求体: `application/json`

Find images visually similar to a seed. Reuses the same embedding
matrix and post-processing pipeline as /images/match — only the query
vector source differs (image embedding instead of text embedding).

---

### `GET /open-api/v1/images/{image_id}`

**Get Image**

- 所需 scope: `images:read`
- 参数:
  - `image_id` (path) (required) — 

---

### `GET /open-api/v1/images/{image_id}/derivatives`

**List Derivatives**

- 所需 scope: `images:read`
- 参数:
  - `image_id` (path) (required) — 

All images that were generated from this seed (parent_id chain).

---

### `GET /open-api/v1/images/{image_id}/file`

**Get Image File**

- 所需 scope: `images:read`
- 参数:
  - `image_id` (path) (required) — 
  - `size` (query) — 

---

### `POST /open-api/v1/images/{image_id}/track-usage`

**Track Usage**

- 所需 scope: `images:match`
- 请求体: `application/json`
- 参数:
  - `image_id` (path) (required) — 

UGC client reports that an image was chosen / displayed. Drives
precision telemetry and (later) weight tuning.

Idempotency: client SHOULD pass request_id so duplicates can be merged
in analysis. Server stores every call as a separate row to keep the
write hot path fast.

---

### `GET /open-api/v1/match/strategies`

**List Strategies**

- 所需 scope: `images:match`

Static list of strategy presets the client can pick from.

---

### `GET /open-api/v1/matrix`

**Coverage Matrix**

- 所需 scope: `images:read`
- 参数:
  - `project_id` (query) (required) — 
  - `row` (query) — 
  - `col` (query) — 

Cell counts for `row × col` tag dimensions.

---

### `GET /open-api/v1/stats`

**Stats**

- 所需 scope: `images:read`
- 参数:
  - `project_id` (query) — 

---

### `GET /open-api/v1/tags`

**List Tags**

- 所需 scope: `tags:read`
- 参数:
  - `project_id` (query) — 
  - `dimension` (query) — 

---


## 完整 OpenAPI 规范

- JSON: https://api.example.com/openapi.json
- Swagger UI（交互式测试）: https://api.example.com/docs
- Redoc: https://api.example.com/redoc

## 联系

- 接口问题反馈: 在 GitHub 仓库提 issue（开发完成后公开 URL）
- 紧急事故: 联系运营 / 后端 owner
