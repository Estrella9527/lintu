# 匹配效果基线 SOP

> 这是 v0.3 上线后**所有匹配策略改动**的唯一对照基准。改了权重 / 加了信号 / 调了同义词后，
> 必须用同一脚本跑同一个数据集，diff > 5% 必须解释。

---

## 1. 数据集

文件：`apps/sidecar/tests/match/eval_dataset.json`

- 已固化 **30 条查询**，跨 6 类主题：亲子 / 情侣 / 山景 / 漂流 / 餐饮 / 边界退化
- 每条 query 字段：
  - `id`：q01..q30
  - `text`：UGC 风格的中文文本
  - `tags`：人工拉的主题标签（用于按类别聚合命中率）
  - `ideal_image_ids`：**待标注** — 运营人工挑出的最相关 image_id 列表

数据集**只增不删，不改 id**。新增 query 用 q31, q32, ... 续号。

---

## 2. 标注流程（一次性，约 1 人天）

每条 query 标注步骤：

1. 在桌面端「匹配实验室」里跑这条 query（参数：strategy=balanced，limit=12，randomness=0）
2. 从前 12 张结果中挑出 **3-8 张真正相关**的图，复制 `image_id`
3. 把 id 数组填入 `eval_dataset.json` 该 query 的 `ideal_image_ids`
4. 边界 query（"asdf"、emoji、空字符串等）的 `ideal_image_ids` 留空 — 跑分时跳过它们
5. 全部标完后 commit，PR 标题 `data(eval): seed v0.3 baseline annotations`

**标注准则**：
- "相关" = 用户看到这张图会觉得"刚才那段文字描述的就是这个画面"
- 宁严勿宽：只挑确凿相关的；模棱两可不算
- 同一原图的 AI 风格化版本算 1 张（取最贴切的一版）

---

## 3. 跑基线（每次匹配相关改动）

```bash
cd apps/sidecar

# 启动云端 sidecar 或本地 sidecar
uv run uvicorn sidecar.main:app --port 7879 --host 127.0.0.1 &

# 跑评估
uv run python scripts/eval_match.py \
    --strategy balanced \
    --output ../../docs/operations/baseline_v030.md \
    --skip-unannotated
```

输出指标：
- `mean_recall_at_1/3/5/8/12`：标注的 ideal 中前 K 命中比例
- `mean_mrr`：第一个命中位置的倒数平均（越大越好）
- `avg_latency_ms / p95_latency_ms`：延迟分布

---

## 4. 基线对比

把当前跑的报告与 `baseline_v030.md` 比较：

| 指标 | 基线 | 当前 | diff | 是否阻断 |
|---|---|---|---|---|
| mean_recall_at_8 | 0.65 | 0.62 | -4.6% | ✅ 在 5% 内 |
| mean_mrr | 0.55 | 0.49 | -10.9% | ❌ 超过 5%，必须解释 |
| p95_latency_ms | 1700 | 2100 | +23.5% | ❌ 性能退化 |

**diff > 5% 处理流程**：
1. 找出退化最严重的 5 条 query，看具体匹配结果
2. 排查改动是否影响了这些 query 的关键信号（embedding / tag / quality）
3. 如确属 trade-off（牺牲 A 换 B），在 PR 描述写明
4. 如属意外退化，回滚

---

## 5. CI 集成（v0.4 计划项 P1-36）

未来匹配相关 PR 会自动跑一遍 eval 并在 PR 评论里贴 diff 表格。当前阶段需要开发者本地手动跑。

---

## 6. 同义词补充

匹配失败的 query 应该作为**同义词候选**补到 `match_synonyms.json`：

1. 跑 `eval_match.py` 时关注 `recall_at_8 == 0` 的 query
2. 看这些 query 的关键词为什么没召回到合适的图
3. 补到匹配策略 Tab → 同义词区，立即生效（无需重启）

---

## 7. 归档

每次大版本（v0.3 / v0.4）跑完基线后，把报告复制到 `docs/operations/baseline_v0X0.md`，与代码同 commit。
