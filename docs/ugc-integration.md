# 灵图 OpenAPI · UGC 对接文档

> 给 **UGC 后端 / 前端开发同学**。从拿到 token 到上线对接，1 小时内能跑通。
>
> 完整接口字段参考：[Swagger UI](https://api.example.com/docs)（可交互测试）｜ [OpenAPI JSON](https://api.example.com/openapi.json)

---

## 我能拿到什么

**你给一段文本，我返回最匹配的图片**：
- 输入：用户发的笔记 / AI 生成的文案 / 活动描述（中文，10-1000 字皆可）
- 输出：N 张图片的 OSS CDN 直链 + 标签 + 匹配度
- 图片二进制不经过我，前端 `<img src>` 直接加载阿里云 CDN

**不要把我当通用图床**。我**只**返回事先在素材库里有 tag 和 embedding 的图（景区精选图）。

---

## 5 分钟接入

### 第 1 步：拿 Bearer Token

向运营要一对 `key_id` + `secret`，拼成：

```
Authorization: Bearer lk_live_xxxxx.yyyyyyyy
                      └─ key_id ─┘ └─secret┘
```

每个 token 有 scope（权限）和 limit（限流）。要写权限或更高 limit 找运营。

### 第 2 步：调匹配接口（**核心，UGC 必调**）

```bash
curl -X POST https://api.example.com/open-api/v1/images/match \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "周末带孩子来漂流，水花四溅超开心",
    "limit": 8,
    "scope": { "primary_project_id": "00000000-0000-0000-0000-aaaaaaaaaaaa" }
  }'
```

返回（节选）：
```json
{
  "matches": [
    {
      "image_id": "c809197e-a90b-4b37-be56-45260103e3d7",
      "rank": 1,
      "score": 0.7594,
      "url": "https://your-bucket.oss-cn-hangzhou.aliyuncs.com/i/c809197e-...jpg",
      "thumbnail_url": "https://your-bucket.oss-cn-hangzhou.aliyuncs.com/i/c809197e-..._thumb_300.jpg",
      "matched_tags": [
        {"dimension": "season", "value": "夏季"},
        {"dimension": "facility", "value": "漂流"}
      ],
      "file_name": "DJI_xxx.JPG",
      "width": 4032, "height": 2268,
      "source_type": "original"
    },
    ...
  ],
  "took_ms": 1635,
  "debug": { "...": "可忽略" }
}
```

### 第 3 步：前端展示

直接用 `url` 字段：

```html
<img src="{{ match.url }}" loading="lazy" />
```

**不要把图片二进制下载到自己服务器再代理**——那是带宽浪费。CDN 已经全国加速，浏览器直连 OSS 即可。

### 第 4 步（可选但推荐）：上报用户实际选了哪张

```bash
curl -X POST https://api.example.com/open-api/v1/images/<image_id>/track-usage \
  -H "Authorization: Bearer <YOUR_TOKEN>"
```

我们用这个数据反向训练匹配权重。**强烈推荐做**——质量会越用越好。

---

## 接口清单

UGC 真正需要的只有 3 个：

| Method | Path | 用途 | 必调 |
|---|---|---|---|
| `POST` | `/open-api/v1/images/match` | 文本→图片匹配 | ✅ |
| `POST` | `/open-api/v1/images/{id}/track-usage` | 用户选了哪张 | 推荐 |
| `GET`  | `/open-api/v1/health` | 健康检查 | 调试用 |

下面这些**不要常规调**（限流低 + 慢 + 你也用不上）：
- `GET /open-api/v1/images` — 翻页全量列表（开发调试用）
- `GET /open-api/v1/images/{id}` — 单张图详情
- `GET /open-api/v1/tags` — 拿全量标签 schema
- `GET /open-api/v1/stats` — 项目统计

---

## `POST /images/match` 详解

### 请求体（JSON）

```jsonc
{
  "text": "...",                         // 必填，1-2000 字
  "limit": 8,                            // 默认 8，最大 50
  "strategy": "balanced",                // 可选: precise | balanced | diverse
  "diversity": "balanced",               // 可选: strict | balanced | none
  "randomness": 0.0,                     // 0=完全确定（同 query 永远同结果）；0.3-0.5=刷新有变化；1.0=分数带内大幅打乱
  "scope": {
    "primary_project_id": "uuid"         // 推荐传，让我知道这条文案对应哪个景区
  },
  "filters": {                           // 可选过滤
    "source_type": "original",           // original | generated（不传=全部）
    "scene": ["山地景观", "玻璃滑道"],     // 限定 scene 维度（白名单）
    "season": ["夏季"],                  // 限定 season
    "exclude_tags": {                    // 排除某些标签（黑名单）
      "weather": ["雨天"]
    }
  },
  "weights": {                           // 高级：自定义信号权重
    "embedding": 0.45,
    "tag": 0.30,
    "quality": 0.10,
    "diversity": 0.10,
    "business": 0.05
  }
}
```

### 字段语义速查

| 字段 | 含义 | 默认 / 推荐 |
|---|---|---|
| `text` | 用户文案 / AI 生成的描述。**长度无硬限**，但 > 500 字时建议截断（embed 会变慢） | — |
| `limit` | 返回图片数 | 8（适合卡片瀑布流） |
| `scope.primary_project_id` | 主景区。结果只来自这个景区，不跨景区污染 | **强烈建议传** |
| `filters.source_type` | `original`=拍摄原图；`generated`=AI 生成图 | 不传=全部 |
| `strategy` | 信号权重预设。`precise`=embedding 主导；`diverse`=多样性主导 | `balanced` |
| `diversity` | 同 parent / 同文件夹 / 同 scene+facility tag 组最多几张 | `balanced`=每组 ≤2 |
| `randomness` | 0=完全确定，每次同结果；0.3-0.5=刷新页面会换一些（推荐生产用）；1.0=分数带内大幅打乱 | `0` — 文案重复时建议升到 0.3-0.5 让用户每次刷新看到新图 |

### 响应字段（精简）

```ts
type MatchResponse = {
  matches: Array<{
    image_id: string;
    rank: number;                // 1-based
    score: number;               // 0-1，越高越像
    url: string;                 // ★ 原图 OSS CDN 直链
    thumbnail_url: string;       // 300px 缩略图 OSS 直链
    matched_tags: Array<{ dimension: string; value: string }>;
    file_name: string;
    width: number; height: number;
    source_type: "original" | "generated";
    description: string;         // 这张图的 AI 描述
    cdn_synced: boolean;         // true=url 是 CDN，false=后端兜底（罕见）
  }>;
  took_ms: number;
  debug: { ... };                // 可忽略，前端不展示
};
```

---

## 完整代码示例

### Node.js / TypeScript

```ts
const ENDPOINT = 'https://api.example.com/open-api/v1';
const TOKEN = process.env.LINTU_TOKEN!;
const PROJECT_ID = '00000000-0000-0000-0000-aaaaaaaaaaaa'; // 示例景区A

async function matchImages(text: string, limit = 8) {
  const resp = await fetch(`${ENDPOINT}/images/match`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      limit,
      scope: { primary_project_id: PROJECT_ID },
    }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.matches.map((m: any) => ({
    id: m.image_id,
    url: m.url,
    thumb: m.thumbnail_url,
    score: m.score,
    tags: m.matched_tags,
  }));
}

async function trackPick(imageId: string) {
  // 用户在结果里选了某张，回报。失败不阻塞业务。
  fetch(`${ENDPOINT}/images/${imageId}/track-usage`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  }).catch(() => {});
}
```

### Python

```python
import os, httpx

ENDPOINT = "https://api.example.com/open-api/v1"
TOKEN = os.environ["LINTU_TOKEN"]
PROJECT_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa"

def match_images(text: str, limit: int = 8) -> list[dict]:
    r = httpx.post(
        f"{ENDPOINT}/images/match",
        headers={"Authorization": f"Bearer {TOKEN}"},
        json={
            "text": text,
            "limit": limit,
            "scope": {"primary_project_id": PROJECT_ID},
        },
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["matches"]

def track_pick(image_id: str) -> None:
    try:
        httpx.post(
            f"{ENDPOINT}/images/{image_id}/track-usage",
            headers={"Authorization": f"Bearer {TOKEN}"},
            timeout=3,
        )
    except Exception:
        pass  # 失败不阻塞
```

### 浏览器直连（仅 SPA 演示，生产不推荐 — 会暴露 token）

```js
// 生产请走后端代理调，不要把 token 放前端
fetch('https://api.example.com/open-api/v1/images/match', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ text, limit: 8, scope: { primary_project_id: PROJECT_ID } }),
}).then(r => r.json()).then(d => render(d.matches));
```

---

## 项目（景区）ID

当前 2 个景区：

| 名称 | `primary_project_id` |
|---|---|
| 示例景区A | `00000000-0000-0000-0000-aaaaaaaaaaaa` |
| 示例景区B | `00000000-0000-0000-0000-bbbbbbbbbbbb` |

未来新增景区，运营会提前通知给新 ID。建议**配置化存储**而不是硬编码。

---

## 错误处理

### HTTP 状态码

| 码 | 含义 | 处理 |
|---|---|---|
| 200 | 成功 | 渲染 `matches`；如果空数组 = 没匹配到，提示用户换关键词或放宽 filter |
| 400 | 请求体格式错（JSON 解析失败 / 缺必填字段） | 检查代码 |
| 401 | Token 无效 / 已停用 / 过期 | 找运营换 token；不要重试 |
| 403 | scope 权限不够 / origin 不在白名单 / IP 不在白名单 | 找运营开权限 |
| 429 | 触发限流（per_minute 或 per_day） | **指数退避重试**（见下） |
| 500 | 服务端异常 | 重试 1 次；持续失败找后端 |
| 502 / 504 | 网关问题 | 重试 1-2 次 |

### 推荐重试策略（429 / 5xx）

```python
import time, random
def with_retry(fn, max_attempts=3):
    for attempt in range(max_attempts):
        try:
            return fn()
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (429, 502, 504) and attempt < max_attempts - 1:
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
```

不要无限重试 401 / 403 — 是配置问题不是网络问题。

### 空结果（200 + matches=[]）的处理

返回空意味着：
- 文案完全没命中任何标签 → 引导用户换更具体的描述（如加景区名、季节、设施）
- 或 filter 过严（比如 `filters.source_type=generated` 但该项目没生成图）

UI 建议：显示"暂无匹配图片，试试[换景区/移除筛选]"，而不是报错。

---

## 性能与限流

### 当前基准
- 端到端 ~1.6s（doubao embedding API 是主要耗时，已最大化并发）
- 同样的 query 在云端无缓存（每次都重新算 embedding）

### 限流（默认）
- per_minute=60、per_day=10000（运营给你的 token 设的，可调）
- 超过 → 429
- 注意：限流是按 **token 维度**，所以多个 UGC 服务用同一 token 会互相挤占

### 客户端优化建议
1. **缓存匹配结果**（KV/Redis），key=hash(text+project_id+filters)，TTL 1-7 天
   - UGC 同一笔记被多人浏览时省后端 + 省你 quota
2. **Lazy load 图片**：`<img loading="lazy">` 让滚到才加载 CDN
3. **使用缩略图**做列表页，点击大图才加载 `url`
4. **不要预加载**所有 8 张原图（4MB+ 一张）

---

## CDN URL 注意事项

`url` 和 `thumbnail_url` 直接指向阿里云 OSS：
- 公网可读（无签名）
- HTTPS
- 长期有效（除非图被运营删了 → 你应该用 `track-usage` 反向监控失效率）
- 阿里云 CDN 加速，首字节延迟 < 100ms

**不要做的事**：
- ❌ 把 url 缓存超过 30 天（图可能被替换）
- ❌ 在自己服务器代理转发（带宽白送）
- ❌ 把 url 写死在 HTML 静态文件（被替换后死链）

**应该做的事**：
- ✅ 每次刷新页面时调 match 拿最新 url
- ✅ 浏览器直接 `<img src>` 加载

---

## 安全建议

1. **Token 不能进前端 JS**。后端代理调，前端只接收最终 url 列表。
2. 如果一定要前端直连（H5 / 小程序），用 `client_type=client` 的 key，且开 `allowed_origins` 白名单。
3. **不要把 token 提到 GitHub**（用 .env.local + .gitignore）。
4. 怀疑 token 泄漏 → 立即找运营停用 + 换新 token，不要等。

---

## 联调 checklist

上线前过一遍：

- [ ] Token 配置在后端 env，前端代码 0 个明文 token
- [ ] 至少调通一次匹配（200 响应 + matches 非空）
- [ ] 浏览器能加载 url（无 CORS / 无 403）
- [ ] track-usage 能调通（不影响主业务）
- [ ] 429 / 5xx 实现了指数退避
- [ ] 空结果有 UI 兜底（不是白屏）
- [ ] 监控 / 日志接了 took_ms 和错误码（可选但强烈推荐）

---

## 在线测试

不写代码也能测：

- **Swagger UI**: https://api.example.com/docs  
  点 Authorize → 输 `Bearer <token>` → 选 `POST /images/match` → Try it out
- **可视化 Demo**: https://api.example.com/demo/  
  填 token → 输入文案 → 看图片网格 + 耗时分布 + 5 次基准

---

## 联系

- 接口问题 / 文档不清：在运营建的对接群艾特后端
- 紧急（线上挂了）：运营手机
- 申请新 ApiKey / 改 scope / 加限流：找运营提工单
