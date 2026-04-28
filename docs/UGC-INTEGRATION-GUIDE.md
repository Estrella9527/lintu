# 外部 UGC 应用接入灵图 Lintu Open API · 实战指南

适用对象：景区 H5 / 小程序 / 公众号 / 抖音号 / 内部 CMS 的开发者。

读完这份文档你能：
1. 拿到一个 API Key
2. 用一段文本调出 N 张配图
3. 把 CDN URL 直接渲染到你的应用里

预计 15 分钟跑通。

---

## 0. 先决条件（运营/管理员侧已完成）

✅ 阿里云 OSS 已配，bucket 中已有图片  
✅ Open API 服务已部署（`LINTU_MODE=server`，公网可达，HTTPS 已配）  
✅ 灵图全库已跑过：质量检查 / 打标 / 向量化（embedding 已对齐）

> 你（UGC 开发者）只需要 4 件东西：**API Base URL、API Key（key_id + secret）、CDN 域名、scope 列表**。运营会给你。

---

## 1. 5 分钟跑通

### 1.1 创建 API Key（运营侧操作）

灵图 → **分发中心 → API Keys → 新建 API Key**

| 字段 | 推荐 |
|---|---|
| 名称 | `Sandu H5 生产` |
| 客户端类型 | `server`（你的后端代理调用）/ `h5`（直接浏览器调用 — 不推荐，secret 暴露） |
| 权限 (scopes) | `images:read,images:match,images:download,tags:read` |
| 允许来源 | 留空（server 调用）/ 填你 H5 域名（CORS 限制） |
| 每分钟限 | `60`（按你流量调） |
| 每日限 | `10000` |

点「创建」→ 弹窗显示 **plain-text secret，只显示一次** → 立刻复制保存到密钥管理器。

最终拿到一段 Bearer Token：
```
lk_live_abc123def456789.AbCdEf...32位...
```

### 1.2 用 curl 调通

```bash
TOKEN="lk_live_xxx.<secret>"
curl -X POST https://api.lintu.example.com/open-api/v1/images/match \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "周末带孩子来这里玩，秋天的山地特别美",
    "limit": 6,
    "strategy": "balanced"
  }'
```

返回（节选）：
```json
{
  "matches": [
    {
      "image_id": "abc123",
      "rank": 1,
      "score": 0.84,
      "url": "https://cdn.lintu.example.com/i/abc123.jpg",
      "thumbnail_url": "https://cdn.lintu.example.com/i/abc123_300.jpg",
      "width": 4096,
      "height": 2730,
      "matched_tags": [
        {"dimension": "season", "value": "秋季"},
        {"dimension": "scene", "value": "山地景观"}
      ],
      "tags": { "scene": ["山地景观"], "season": ["秋季"], ... },
      "description": "画面：秋天阳光下山间的小火车…氛围：温馨…适合：亲子…"
    },
    ...
  ],
  "took_ms": 247
}
```

### 1.3 在网页里渲染

```html
<img src="https://cdn.lintu.example.com/i/abc123.jpg" />
```

✓ 直接展示，CDN 加速。

---

## 2. 接口完整列表

| 端点 | 方法 | 用途 | 必需 scope |
|---|---|---|---|
| `/open-api/v1/health` | GET | 健康检查（公开） | — |
| `/open-api/v1/images/match` | POST | **文图匹配**（核心） | `images:match` |
| `/open-api/v1/images` | GET | 列表 + 多维度筛选 | `images:read` |
| `/open-api/v1/images/{id}` | GET | 单图详情（标签 + 描述） | `images:read` |
| `/open-api/v1/images/{id}/file` | GET | 图片文件（fallback，OSS 未同步时） | `images:download` |
| `/open-api/v1/images/{id}/derivatives` | GET | 该图的 AI 衍生图 | `images:read` |
| `/open-api/v1/images/{id}/track-usage` | POST | 反馈被使用了 | `images:match` |
| `/open-api/v1/match/strategies` | GET | 列出可用策略预设 | — |
| `/open-api/v1/tags` | GET | 标签分布统计 | `tags:read` |
| `/open-api/v1/stats` | GET | 总量/已打标/AI生成等 | `stats:read` |
| `/open-api/v1/matrix` | GET | 标签覆盖矩阵 | `tags:read` |

**Swagger 在线文档**：`https://api.lintu.example.com/docs`

---

## 3. 文图匹配 `/images/match` 详解

### 3.1 完整请求体

```json
{
  "text": "周末带孩子来这里玩，秋天的山地特别美",
  "limit": 8,
  "strategy": "balanced",
  "diversity": "balanced",
  "weights": null,
  "filters": {
    "scene": ["山地景观", "森林步道"],
    "season": ["秋季"],
    "people": ["少量游客", "儿童"],
    "exclude_tags": { "weather": ["雨天"] },
    "source_type": "original",
    "project_id": "<project_uuid>",
    "folder_prefix": "【1】悬崖过山车"
  }
}
```

### 3.2 字段说明

| 字段 | 必需 | 类型 | 说明 |
|---|---|---|---|
| `text` | ✅ | string | 用户描述 / 大模型生成的文案。**长度 < 1000 字最佳**；过长会被截断 |
| `limit` | — | int | 返回多少张（默认 8，最大 50） |
| `strategy` | — | enum | `precise` 严格 / `balanced` 平衡（默认）/ `diverse` 多样 |
| `diversity` | — | enum | `strict` 同组只取 1 张 / `balanced` 默认 / `none` 不限 |
| `weights` | — | object | 自定义权重，覆盖 strategy（高级用法，看 4.4） |
| `filters.scene` | — | string[] | 必须命中其中一个值 |
| `filters.exclude_tags` | — | dict | `{"weather":["雨天"]}` 排除有这些标签的图 |
| `filters.source_type` | — | enum | `original` 仅原图 / `generated` 仅 AI 生成 |
| `filters.project_id` | — | string | 限定到某个项目（多项目部署） |
| `filters.folder_prefix` | — | string | 限定到某个文件夹（如某个景点） |

### 3.3 响应字段

每个 match 包含：
- `image_id` · `rank` (1-based) · `score` (0-1)
- `url` — **CDN 直链**（已 OSS 同步时）；未同步时回落 `/file` 端点（需 `images:download` scope）
- `thumbnail_url` — 300px CDN 缩略图
- `cdn_synced` — bool：`false` 时说明这张图刚生成还没同步，URL 需要 download scope
- `score_breakdown` — 各项贡献：`{embedding, tag, quality, business, rrf_boost}`
- `matched_tags` — 命中的 tag 维度
- `tags` — 该图所有标签（按维度分组）
- `description` — 50-80 字结构化描述
- `width / height / file_name / source_type`

### 3.4 strategy 选哪个？

| strategy | embedding 权重 | tag 权重 | 适合场景 |
|---|---|---|---|
| `precise` | 0.55 | 0.35 | 严格匹配（专业 CMS、文档配图） |
| `balanced`（默认） | 0.45 | 0.30 | 通用 UGC，9 成场景用这个 |
| `diverse` | 0.30 | 0.20 | 浏览/灵感场景，宁可多样 |

### 3.5 调用前要不要 expand 自己的文本？

**不用**。灵图后端已经自动做了 query expansion（用 LLM 把短查询扩成 15-25 个语义词云 + 同义词替换 + 跨模态 embedding 召回）。你直接传用户原文 / 大模型生成的文案就行。

---

## 4. 完整代码示例

### 4.1 Node.js (后端代理)

```typescript
// match.ts
import { fetch } from 'undici'

const API_BASE = 'https://api.lintu.example.com'
const TOKEN = process.env.LINTU_API_KEY!  // lk_live_xxx.<secret>

interface MatchedImage {
  image_id: string
  rank: number
  score: number
  url: string
  thumbnail_url: string
  width: number
  height: number
  matched_tags: { dimension: string; value: string }[]
  description: string
}

export async function matchImages(text: string, limit = 6): Promise<MatchedImage[]> {
  const res = await fetch(`${API_BASE}/open-api/v1/images/match`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      limit,
      strategy: 'balanced',
      filters: { source_type: 'original' },
    }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(`Lintu match failed: ${(err as any).error?.message || res.status}`)
  }
  const data: any = await res.json()
  return data.matches
}

// 使用
const text = '周末带孩子来这里玩，秋天的山地特别美'
const images = await matchImages(text, 6)
console.log(images.map(m => m.url))
```

### 4.2 Python (后端)

```python
import os
import requests

API_BASE = 'https://api.lintu.example.com'
TOKEN = os.environ['LINTU_API_KEY']

def match_images(text: str, limit: int = 6) -> list[dict]:
    r = requests.post(
        f'{API_BASE}/open-api/v1/images/match',
        headers={'Authorization': f'Bearer {TOKEN}'},
        json={'text': text, 'limit': limit, 'strategy': 'balanced'},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()['matches']

# 使用
matches = match_images('梦幻浪漫的婚纱外景', limit=8)
for m in matches:
    print(f"#{m['rank']} score={m['score']:.2f}  {m['url']}")
```

### 4.3 微信小程序

```js
// pages/match/match.js
const API_BASE = 'https://api.lintu.example.com'

Page({
  data: { matches: [] },

  async loadByText(text) {
    // ⚠️ 不要把 secret 放在小程序里 — 让你的服务端代理调用并返回结果。
    const res = await wx.cloud.callFunction({
      name: 'lintuMatch',
      data: { text, limit: 6 }
    })
    this.setData({ matches: res.result.matches })
  }
})
```

```html
<!-- match.wxml -->
<view wx:for="{{matches}}" wx:key="image_id" class="card">
  <image src="{{item.thumbnail_url}}" mode="aspectFill" class="thumb" />
  <text>{{item.description}}</text>
</view>
```

### 4.4 高级：自定义权重

如果你的场景对某个维度特别敏感（比如 OTA 详情页要严格的视觉相关性）：

```json
{
  "text": "...",
  "weights": {
    "embedding": 0.7,
    "tag": 0.2,
    "quality": 0.1,
    "diversity": 0.0,
    "business": 0.0
  }
}
```

5 个权重相加不强制为 1，但建议在 0.8-1.2 之间。

---

## 5. 反馈接口（强烈建议接）

用户从你给的 6 张候选中点选了哪张？告诉灵图。**反馈数据驱动后续策略调优。**

```bash
curl -X POST $API_BASE/open-api/v1/images/{image_id}/track-usage \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "request_id": "req_xyz",
    "text": "原始 query",
    "rank": 3,
    "score": 0.78,
    "was_chosen": true
  }'
```

最低限度：用户选中时调一次 `was_chosen: true`，运营侧能看到「点击率」。

---

## 6. 错误响应格式

所有失败统一格式：
```json
{
  "error": {
    "code": "forbidden_scope",
    "message": "this api key is missing required scope: images:match",
    "request_id": "req_abc",
    "required_scope": "images:match"
  }
}
```

| HTTP 状态 | code | 含义 | 你怎么办 |
|---|---|---|---|
| 401 | `unauthorized` | Token 无效 / 过期 | 重新生成 / 换 token |
| 403 | `forbidden_scope` | scope 不够 | 找运营加 `images:match` |
| 403 | `forbidden_origin` | CORS 域名不在白名单 | 找运营加你的 origin |
| 403 | `forbidden_ip` | IP 不在白名单 | 找运营加 IP |
| 422 | `invalid_request` | body 字段不对 | 看 `errors` 字段 |
| 429 | `rate_limited` | 每分钟超限 | 头里有 `Retry-After: 60`，等一分钟 |
| 429 | `quota_exceeded` | 当日额度用完 | 等次日 / 找运营加 quota |
| 500 | `internal_error` | 灵图后端故障 | 拿 `request_id` 找运营查 |

---

## 7. CDN URL 直接拉图（不走 API）

`match` 返回的 `url` 字段是 CDN 直链，**任何客户端**（浏览器 / 小程序 / 移动 App）都能直接拉，**不需要 token**：

```
https://cdn.lintu.example.com/i/abc123.jpg          ← 原图
https://cdn.lintu.example.com/i/abc123_800.jpg      ← 800px 缩略图
https://cdn.lintu.example.com/i/abc123_300.jpg      ← 300px 缩略图
```

**性能**：CDN 边缘节点缓存，全国 P95 < 200ms。

**防盗链**：运营在阿里云 OSS 配「Referer 白名单」后，只有你的域名能拉。

**签名 URL（私密 bucket 模式）**：如果运营开启了「签名 URL TTL > 0」，`url` 会自动带 `?Expires=...&Signature=...`，超时失效。建议每次都重新拿（不要缓存超过 30 分钟）。

---

## 8. 性能与配额

| 指标 | 典型值 | 说明 |
|---|---|---|
| `/match` 响应 P95 | 300-800ms | 含 LLM query expansion + Ark embedding + 召回融合 |
| `/match` 响应 P50 | 80-200ms | 缓存命中时（同一 query） |
| 图片首字节 (CDN) | 30-100ms | 全国 |
| 图片整图（800KB JPEG） | < 500ms | 取决于带宽 |
| 默认每分钟限 | 60 | 由 API Key 上的 rate_limit 决定 |
| 默认每日额度 | 10000 | 同上 |

**优化建议**：
- 在你后端**缓存 match 结果**（key=text 的 sha256，TTL 5-60 分钟），减少重复调用
- 同一个文案的多次匹配走你自己的缓存
- 用户切换查询时再调灵图

---

## 9. 推荐接入流程图

```
用户输入文字
   ↓
[你的应用前端]
   ↓ 发送给后端
[你的应用后端]
   ↓ POST /open-api/v1/images/match
   ←  matches[] (含 CDN URL)
   ↓
[你的应用前端]  ← 渲染缩略图供用户挑
   ↓ 用户点选 1-3 张
[你的应用前端]  ← <img src="https://cdn.lintu...">
   ↓ 后台异步上报
   ↓ POST /track-usage  was_chosen=true
[你的应用后端]
   ↓ 用户最终发布
[原平台 / OTA / 小红书等]
```

---

## 10. 联系与排错

- **调用日志**：运营在「分发中心 → 调用日志」能查每个 Key 的全部调用历史，包含 method/path/status/latency/IP/UA
- **使用统计**：「分发中心 → API Keys → 每个 Key 卡片」会显示当日用量 + 7 天 sparkline
- **匹配命中率分析**（S5.4 完成后）：「分发中心 → 匹配分析」展示哪类 query 命中率高、哪些图被反复选中

任何问题，提供：
- `request_id`（错误响应里都有）
- 时间戳
- 你调用的端点 + 参数

发给运营对应排查。

---

**文档结束**
