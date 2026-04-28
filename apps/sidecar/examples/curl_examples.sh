#!/usr/bin/env bash
# 灵图 Open API v1 — curl 示例集
#
# 用法:
#   export LINTU_BASE=https://api.your-domain.com   # 或 http://localhost:7879
#   export LINTU_TOKEN=lk_live_xxx.your_secret      # 桌面端创建后复制
#   bash curl_examples.sh

set -euo pipefail

: "${LINTU_BASE:=http://localhost:7879}"
: "${LINTU_TOKEN:?需要先设置 LINTU_TOKEN=lk_live_xxx.secret}"

H="Authorization: Bearer ${LINTU_TOKEN}"

echo "=== 健康检查（公开，不需要 token）==="
curl -fsS "${LINTU_BASE}/open-api/v1/health" | jq .

echo
echo "=== 汇总统计 ==="
curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/stats" | jq .

echo
echo "=== 图片列表（前 5 张原图）==="
curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/images?source_type=original&limit=5" | jq '.items[] | {id, file_name, width, height}'

echo
echo "=== 标签维度分布 ==="
curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/tags?dimension=scene" | jq .

echo
echo "=== 选一张图，看它的衍生图 ==="
SAMPLE_ID=$(curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/images?limit=1" | jq -r '.items[0].id')
echo "SAMPLE_ID=${SAMPLE_ID}"
curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/images/${SAMPLE_ID}/derivatives" | jq .

echo
echo "=== 下载缩略图（300px）==="
curl -fsS -H "$H" \
  "${LINTU_BASE}/open-api/v1/images/${SAMPLE_ID}/file?size=300" \
  -o /tmp/lintu_sample_300.jpg
ls -lh /tmp/lintu_sample_300.jpg

echo
echo "=== 覆盖矩阵（场景 × 季节）==="
PROJECT_ID=$(curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/images?limit=1" | jq -r '.items[0].id // ""')
# 矩阵端点需要 project_id；如果你已知 project_id 直接传入即可
# curl -fsS -H "$H" "${LINTU_BASE}/open-api/v1/matrix?project_id=${PJID}&row=scene&col=season" | jq .

echo
echo "=== 提交批次（需 generate:write 权限的 Key）==="
echo "示例：seed/prompt id 请换成你环境里真实存在的"
echo
cat <<'EOF'
curl -fsS -H "$H" -H "Content-Type: application/json" \
  -X POST "${LINTU_BASE}/open-api/v1/batches" \
  -d '{
    "project_id":  "<project-uuid>",
    "name":        "外部触发 1×1",
    "task_type":   "outpaint",
    "seed_image_ids": ["<image-uuid>"],
    "prompt_ids":     ["<prompt-uuid>"],
    "concurrency": 5,
    "max_retry":   3,
    "budget_usd":  1.0
  }'
EOF

echo
echo "=== 查询批次状态 ==="
echo 'curl -H "$H" "${LINTU_BASE}/open-api/v1/batches/<batch-id>"'
