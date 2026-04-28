# 文图匹配策略 · 执行细节与架构决策

| 字段 | 值 |
|---|---|
| 文档版本 | v1.0 |
| 起草日期 | 2026-04-27 |
| 对应实现 | S5.3.1 - S5.3.12（已落地） |
| 状态 | 已实现，本文档复盘当前真实执行链路 |

---

## 0. 关键决策：匹配策略部署在哪？

> **结论：完全在灵图（Lintu 后端）做。** 外部 UGC 应用只调用一个 HTTP 端点，传 `text` 和可选 `filters`，拿回 ranked images。

### 为什么不能放外部应用做

| 维度 | 放灵图（推荐） | 放外部 UGC 应用 |
|---|---|---|
| **数据持有** | embedding 矩阵（~30MB / 1 万张图）一直在内存 | 外部要拉全库 embedding，每次几十 MB → 不可行 |
| **算力位置** | 召回 / 精排 / 融合都在内存矩阵上算 | 外部要重做相同计算，或者每次拉数据下来算 |
| **策略迭代** | 改一处，所有 UGC 应用受益 | 每个 UGC 应用都要更新代码 |
| **业务规则** | 统一执行（同 dedup_group 只取一张、原图优先等） | 每个 UGC 应用各自实现，易出错 |
| **反馈回流** | track-usage 直接落入 match_feedback 表，闭环 | 反馈分散在各 UGC 库里，无法做全局调优 |
| **数据安全** | embedding / tag 不外泄 | 必须把 embedding/tag 全量给到外部 |
| **LLM 调用** | query expansion 内部触发，外部无感 | 外部要自己接 LLM，重复工程 |
| **响应速度** | embedding 矩阵一直 warm，无 I/O 开销 | 外部每次冷启动 |

### 业界对照
- Pinterest / Unsplash / Getty：搜图全在自家后端做，对外只给 ranked API
- OpenAI / Anthropic 视觉模型：只暴露 raw embedding；策略层由调用方做（但他们对接的是技术开发者，不是 UGC 业务方）
- 火山方舟 / 千帆等行业内部：策略在自家服务侧

### 给外部应用保留的"调节杠杆"

虽然策略在灵图侧实现，但**通过端点参数允许外部精细调整**：

```json
{
  "text": "...",
  "strategy": "precise|balanced|diverse",
  "weights": { "embedding": 0.6, "tag": 0.3, ... },   // 高级用户覆盖
  "diversity": "strict|balanced|none",
  "filters": { "scene": [...], "exclude_tags": {...}, "source_type": "original" }
}
```

外部应用**不需要**理解索引 / 召回 / 融合，**只需要**理解"我想严格匹配 / 想多样浏览"这种业务语义。

---

## 1. 当前真实执行链路（端到端）

外部一次 `POST /open-api/v1/images/match` 请求，灵图内部串行（局部并行）执行 6 个阶段：

```
┌─────────────────────────────────────────────────────────────────┐
│  ① keyword_extract.extract(text)             (同步, 1-3ms)     │
│      jieba 分词 + 自定义词典识别 + 同义词替换                   │
│      → tokens, tag_hits {dim: [values]}                          │
└─────────────────────────────────────────────────────────────────┘
                           │ 并行 (asyncio.gather)
        ┌──────────────────┼──────────────────┐
        ▼                                     ▼
┌────────────────────────────┐   ┌────────────────────────────┐
│ ② query_expansion.expand   │   │ ③ text_search.recall_by_   │
│    _query(text)            │   │    text(text)              │
│   LLM 调用 (Ark/Gemini)    │   │   text → embedding → cosine│
│   → 15-25 个语义关键词     │   │   Top-200 候选             │
│   (LRU cache)              │   │   ~150-300ms (Ark API)     │
│   ~1-3s 首次 / <1ms 缓存   │   │                            │
└────────────────────────────┘   └────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ④ text_search.recall_by_keywords(扩展词集 + jieba 词)          │
│      SQL ILIKE 全表扫 text_search_blob                          │
│      → Top-200 候选                                              │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⑤ _rrf_merge(emb_hits, kw_hits)                                │
│      Reciprocal Rank Fusion: rrf_score = 1/(k+r_emb) + 1/(k+r_kw)│
│      去重，得 ~200-400 候选 dict                                │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⑥ _enrich_and_filter(candidates, filters)                      │
│      一次 SQL 拉所有 candidate 的 Image + Tag                    │
│      应用 user filters (scene/season/exclude_tags/source_type/  │
│      folder_prefix/...)                                          │
│      → enriched rows                                             │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⑦ _score_one(row, weights, expected_tags)                      │
│      计算 final score = w_emb * embedding_sim                    │
│                       + w_tag * tag_hit_density                 │
│                       + w_qual * quality_norm                    │
│                       + w_biz  * business_score                  │
│                       + rrf_boost (capped 0.10)                  │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────────┐
│  ⑧ _apply_diversity(sorted_rows, mode='strict|balanced|none')   │
│      same parent_id / relative_dir 限取 1-2 张                   │
│      → final top-N matches                                       │
└─────────────────────────────────────────────────────────────────┘
                │
                ▼
        响应 JSON (matches[] + debug{})
```

**典型耗时**（北京机房 → Ark 同区）：
- 缓存命中：80-200ms
- 缓存未命中（含 query expansion）：1.5-3s

---

## 2. 各层细节（按代码模块对应）

### 2.1 索引层 — `Image.embedding` + `Image.text_search_blob`

| 字段 | 来源 | 用途 |
|---|---|---|
| `Image.embedding` | `engines/clip_embed.py::run_embed`（流水线 → 向量化） | 跨模态召回的图像侧向量 |
| `Image.embedding_model` | 上同 | 标记模型 tag（用于检测维度不匹配） |
| `Image.text_search_blob` | `scripts/backfill_text_search.py` 一次性 + `tagger.py` 增量 | keyword 召回的全文 ILIKE 目标 |
| `Image.cdn_path` | `engines/oss_sync.py` worker 异步推 OSS | 输出给外部的 CDN URL |

**为什么没做 `image.embedding_text`**（PRD 里写了"可选"）：
- Ark vision multimodal embedding 同时接受 text 和 image 输入，且**输出在同一向量空间**
- 直接 `text → vector` vs `image → vector` 做 cosine 即可跨模态召回
- 不需要单独再做"图片侧的文字 embedding"
- 省一份字段、省一次重新打标的成本

### 2.2 关键词抽取 — `engines/keyword_extract.py`

```python
extract("周末带孩子来这里玩，秋天的山地特别美")
→ KeywordExtraction(
    tokens=['周末', '带', '儿童', '来', '这里', '玩', '一天', '秋季', '山地', '美', ...],
    keywords=['周末', '儿童', '一天', '秋季', '山地', '美景', ...],
    tag_hits={
      'people': {'儿童'},
      'season': {'秋季'},
      'scene':  {'山地景观'},  # via 同义词 "山地" → "山地景观"
    }
  )
```

**关键设计**：
- jieba 启动时把 tag schema 12 维所有 200+ 值添加到字典（`add_word(value, freq=10000)`），保证 `"敦煌壁画"` 不被切成 `"敦煌"+"壁画"`
- 同义词表：`孩子→儿童`、`秋天→秋季`、`鸟瞰→航拍` 等 30+ 映射，先做替换再分词
- 中文单字过滤（"美"、"得"、"带" 等不是有意义关键词）
- 子串扫描兜底：值在原文里出现但 jieba 没切出来时，二次匹配补救

### 2.3 召回层

#### 召回 A · 跨模态 embedding 召回

`engines/text_search.py::recall_by_text`

1. 调 `OpenAICompatProvider.embed_text(text)` → 同 image embedding 同空间的向量
   - Ark `doubao-embedding-vision-251215` 走 `/embeddings/multimodal` 端点，input 类型是 `text`
2. 全库 `image.embedding` 反序列化成 numpy 矩阵，**进程级缓存**（`IndexShard`，惰性构建）
3. `matrix @ query_vec` 算余弦（向量预归一化），numpy `argpartition` 取 Top-200

**性能**：1 万张图 1024 维 float32 = 40MB 矩阵，单次余弦 ~5-15ms。10 万张 ~150ms。100 万张需要切 Faiss。

**fallback**：embedding provider 没配 / 维度不匹配 → 召回返回 [] 不挂掉，由召回 B 兜底。

#### 召回 B · 关键词 SQL ILIKE 召回

`engines/text_search.py::recall_by_keywords`

1. 关键词集 = `expand_query 扩展集 ∪ jieba.keywords`
2. 全表扫 `Image.text_search_blob ILIKE '%keyword%'`
3. 命中数 / 关键词总数 = score，Top-200

**优势**：处理"专有名词"（地名、设施名）效果好；这类词 LLM 不一定见过，但人工标注里有
**短板**：O(n × k) 全表扫；> 10 万图需要换 SQLite FTS5 或 Postgres 全文索引

### 2.4 Query Expansion · `engines/query_expansion.py`

把短 query 扩成 15-25 个语义关键词云，让召回 B 命中更多潜在相关图。

```python
expand_query("温馨亲子时光，孩子开心的笑容")
→ ['温馨亲子时光', '亲子时光', '孩子', '儿童', '小朋友', '宝宝', '笑容', '笑脸',
   '微笑', '温馨', '幸福', '快乐', '开心', '欢乐', '治愈', '亲子互动',
   '亲子活动', '家庭时光', '美好生活', '亲子合影', '温暖']
```

**实现细节**：
- LLM 用「设置 → AI 服务商 → 通用模型」配的 provider（默认 Ark Doubao Lite）
- prompt 里给一个 few-shot example
- 8 秒超时；超时不缓存，下次再试
- 成功结果存 LRU 1024 条
- 失败 fallback 到 `[原始 text]`，由 jieba keywords 兜底（不挂）

### 2.5 RRF 融合 · `_rrf_merge`

> RRF (Reciprocal Rank Fusion, Cormack et al. 2009) 是搜索界的标配——把不同来源的排序合并，**只看排名不看分数绝对值**，避免不同打分方式量纲不同导致的偏差。

```python
candidates[image_id].rrf_score = 1/(60 + rank_emb) + 1/(60 + rank_kw)
```

- k=60 是文献推荐值
- 对**两路同时命中**的候选给最高奖励（rrf_score 最大）
- 对**只命中一路**的候选保留位置但分数低
- 对完全未召回的候选直接丢弃

### 2.6 精排 · `_score_one`

每个候选最终分数 = 5 个信号加权 + RRF boost：

| 信号 | 默认权重 | 计算方式 |
|---|---|---|
| `embedding` | 0.45 | `embedding_sim`（cosine 0..1） |
| `tag` | 0.30 | `命中 tag value 数 / query 命中维度的 tag 总数`，无 tag_hits 时退化为 keyword density |
| `quality` | 0.10 | `blur_score / max(blur_score in candidates)`，归一化 |
| `business` | 0.05 | original=1.0, generated=0.5（业务偏好） |
| `diversity` | 0.10 | 后处理阶段惩罚，不在 score_one 计算 |
| `rrf_boost` | (cap 0.10) | `min(rrf_score × 5.0, 0.10)` 兜底，让 RRF 鲁棒性进入分数 |

**3 个预设**（`STRATEGY_PRESETS`，对应外部 strategy 参数）：

| 预设 | embedding | tag | quality | diversity | business | 适合 |
|---|---|---|---|---|---|---|
| `precise` | 0.55 | 0.35 | 0.05 | 0.05 | 0 | 严格 CMS |
| `balanced`（默认） | 0.45 | 0.30 | 0.10 | 0.10 | 0.05 | 通用 UGC |
| `diverse` | 0.30 | 0.20 | 0.15 | 0.30 | 0.05 | 浏览 / 灵感 |

外部传 `weights: {...}` 可整体覆盖。

### 2.7 多样性后处理 · `_apply_diversity`

按 final score 排序后再做"去同源"，防止 8 张返回都来自同一个种子图的 8 个生成版本：

| mode | 同 parent_id 限制 | 同 relative_dir 限制 |
|---|---|---|
| `strict` | 1 张 | 1 张 |
| `balanced`（默认） | 2 张 | 2 张 |
| `none` | 不限 | 不限 |

被砍的候选进入 `runners_up` 队列；如果筛选后凑不够 limit，从 runners_up 补足。

### 2.8 反馈回流 · `match_feedback` 表

外部应用每次用户点选/采用图片后调：
```
POST /open-api/v1/images/{image_id}/track-usage
{
  "request_id": "...",
  "text": "原 query",
  "rank": 3,
  "score": 0.78,
  "was_chosen": true
}
```

写入 `match_feedback` 表的字段：
- `text_hash`: SHA256(query)[:16]，不存原文（隐私）
- `image_id`, `rank`, `score`, `was_chosen`, `created_at`
- `api_key_id`（暂未自动填，后续中间件补）

**用途**（v1.1 起）：
- 计算每个 query → 命中率（has_chosen / total）
- 反向调权（`tag` 权重过高？降一点）
- A/B 不同 strategy
- 找出"反复被搜但没图能命中"的 query → 提示运营补图

---

## 3. 调用方应该怎么用

### 3.1 最小调用（90% 场景够了）

```bash
curl -X POST https://api.lintu.example.com/open-api/v1/images/match \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"温馨亲子时光","limit":6}'
```

灵图内部全部默认值：strategy=balanced, diversity=balanced。

### 3.2 业务定制场景

#### 严格匹配（专业 CMS）
```json
{ "text": "...", "strategy": "precise", "limit": 4 }
```

#### 浏览/灵感场景（小红书）
```json
{ "text": "...", "strategy": "diverse", "limit": 12, "diversity": "strict" }
```

#### 排除特定标签
```json
{
  "text": "亲子游玩",
  "filters": {
    "exclude_tags": { "weather": ["雨天"], "people": ["无人"] }
  }
}
```

#### 高级：自定义权重
```json
{
  "text": "...",
  "weights": { "embedding": 0.7, "tag": 0.2, "quality": 0.1, "diversity": 0, "business": 0 }
}
```

### 3.3 不应该外部做的事

外部应用**绝不应该**：
- ❌ 自己拉灵图全库 embedding 来本地匹配
- ❌ 自己实现关键词召回（jieba 词典需要和灵图 tag schema 同步）
- ❌ 自己做 RRF 融合
- ❌ 把同一段 text 拆成多次小 query 来做"自定义召回"——直接传完整 text，灵图内部已经做了 expansion

### 3.4 应该外部做的事

外部应用**应该**：
- ✅ 在自己后端**缓存 match 结果**（key=sha256(text)，TTL 5-60 分钟）
- ✅ 让用户在多张候选里**人工挑选**最终发布的图
- ✅ 通过 `track-usage` 上报选中结果，让灵图持续优化
- ✅ 业务层的过滤组合（"我们这个频道只用秋天的山景"），通过 `filters` 表达

---

## 4. 部署形态对照（外部应用视角）

```
┌─────────────────────────────────────────┐
│  你的 UGC 应用                          │
│                                         │
│  用户 → 大模型生成文案                  │
│         │                               │
│         ▼                               │
│  你的后端 ─── HTTP POST ──→ 灵图 API   │
│         ▲                       │       │
│         │                       │       │
│         └── matches[] (CDN URLs)        │
│         │                               │
│         ▼                               │
│  你的前端 ── 用户挑选 N 张              │
│         │                               │
│         ├── <img src=cdn.lintu...>      │
│         │                               │
│         └── POST /track-usage ──→ 灵图 │
└─────────────────────────────────────────┘
```

**你完全不用管**：
- embedding 是怎么算的
- 关键词怎么扩
- 多路召回怎么融
- 加权是怎么定的
- 图片在哪个 OSS 里

**你只关心**：
- 一段 text → 一个 array of `{url, score, tags}`
- 用户点了哪张

---

## 5. 演进路线（你不用做，灵图侧做）

| 时点 | 改进点 | 外部应用感知 |
|---|---|---|
| 现在 | RRF 融合 + LLM expansion 已上 | ✅ 召回质量好 |
| v1.1 | match_feedback 调权 | ✅ 命中率提升 |
| v1.2 | 每个 API Key 独立 strategy | ✅ 业务定制更细 |
| v1.3 | 实时索引（新图 30s 内可搜） | ✅ 新生成图立刻可用 |
| v2.0 | 切 Faiss / Qdrant（10 万+ 图） | 透明 |
| v2.1 | 混合检索 + LLM rerank top-20 | 透明 |
| v2.2 | 用户画像驱动个性化（per-user） | 需要传 `user_id` |

---

## 6. 关键问答

**Q: 灵图侧的策略改了，外部应用要不要更新？**
A: 通常不用。除非加了新参数（比如 `weights` 里多了一项），可以选择性用。

**Q: 我能自己组合多个 query 做"和搜索"吗？**
A: 不需要。直接把完整文案传给 `text` 字段，灵图自己做 query expansion，效果比你拼接好。

**Q: 我的 query 命中率不高怎么办？**
A: 先在灵图后台「分发中心 → 调用日志」看实际匹配过程，看 debug 字段：
- `recall_emb=0` → embedding provider 没配 / 库没全部 embed
- `recall_kw=0` → text_search_blob 是空 / 没跑过 tagger
- `tag_hits` 是空 → 文案里完全没用户能识别的关键词，考虑让 LLM 文案里多带场景词

**Q: 多个 UGC 应用共用 API 怎么避免互相影响？**
A: 每个 UGC 应用一个 API Key，scope 限制 + rate limit 隔离。后续 v1.2 会支持 per-key strategy。

**Q: 灵图能不能给"图相似搜图"接口（input 一张图找相似）？**
A: 可以加 `POST /images/similar?seed_image_id=...` 端点，复用同一套 embedding 矩阵。现在 dedup 引擎用的就是这个能力，对外暴露是 1-2 天工作量。需要的话提需求。

---

**文档结束**
