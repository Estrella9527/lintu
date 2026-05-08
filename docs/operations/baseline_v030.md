# 匹配效果基线 v0.3（待生成）

> 本文件由 `apps/sidecar/scripts/eval_match.py` 自动生成。当前为**模板占位**，
> 等运营完成 `eval_dataset.json` 标注后跑脚本覆盖。

---

## 生成方式

```bash
cd apps/sidecar
uv run python scripts/eval_match.py \
    --strategy balanced \
    --output ../../docs/operations/baseline_v030.md \
    --skip-unannotated
```

需要前置条件：
- `apps/sidecar/tests/match/eval_dataset.json` 中 ≥20 条 query 已填 `ideal_image_ids`
- sidecar 跑在 7879 端口，库里有可匹配的图

---

## 标注进度（手动维护，commit 时更新）

| query 范围 | 已标注 | 待标注 |
|---|---|---|
| q01-q10（亲子 / 婚纱 / 山景 / 夜景） | 0 | 10 |
| q11-q20（情侣 / 国风 / 团建 / 蹦极） | 0 | 10 |
| q21-q30（艺术风格 / 节庆 / 海报） | 0 | 10 |
| **合计** | **0** | **30** |

---

## 占位指标（生成报告后会覆盖）

```
mean_recall_at_1   = TBD
mean_recall_at_3   = TBD
mean_recall_at_5   = TBD
mean_recall_at_8   = TBD
mean_recall_at_12  = TBD
mean_mrr           = TBD
avg_latency_ms     = TBD
p95_latency_ms     = TBD
```

详细评估流程见 [match-baseline-sop.md](./match-baseline-sop.md)。
