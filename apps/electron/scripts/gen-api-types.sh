#!/usr/bin/env bash
# 生成 src/renderer/lib/api-types.generated.ts —
# 单一可信源是后端的 OpenAPI schema。前端类型修改不应直接编辑生成文件，
# 而是先改后端 Pydantic model → 跑此脚本 → 生成的 TS 自动跟上。
#
# 用法：
#   cd apps/electron && bash scripts/gen-api-types.sh
#
# 退出码：
#   0 = 成功（生成文件无 diff 或正常更新）
#   1 = 后端 export_openapi.py 失败 / openapi-typescript 失败
#   2 = 在 CI 中检测到 generated 文件与预期不符（用 --check 触发）
#
# 依赖：
#   - openapi-typescript（dev dep；首次跑会用 npx 拉）
#   - 后端 sidecar 必须能本地启动（uv 已 sync）
set -euo pipefail

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/apps/sidecar"
ELECTRON_DIR="$REPO_ROOT/apps/electron"
OPENAPI_JSON="$REPO_ROOT/docs/openapi.json"
OUT_TS="$ELECTRON_DIR/src/renderer/lib/api-types.generated.ts"

echo "[gen-api-types] dumping openapi schema from sidecar..."
( cd "$SIDECAR_DIR" && uv run python scripts/export_openapi.py )

echo "[gen-api-types] generating TS from $OPENAPI_JSON..."
PREV_HASH=""
if [[ -f "$OUT_TS" ]]; then
  PREV_HASH="$(shasum -a 256 "$OUT_TS" | awk '{print $1}')"
fi

# Run via npx so we don't need a global install. Stays inside electron's
# node_modules cache (added via `bun add -d openapi-typescript` if missing).
( cd "$ELECTRON_DIR" && npx --yes openapi-typescript "$OPENAPI_JSON" -o "$OUT_TS" )

NEW_HASH="$(shasum -a 256 "$OUT_TS" | awk '{print $1}')"

if [[ "$CHECK_MODE" == "true" ]]; then
  if [[ "$PREV_HASH" != "$NEW_HASH" ]]; then
    echo "[gen-api-types] ERROR: generated types drifted from committed copy."
    echo "  Run 'bash apps/electron/scripts/gen-api-types.sh' and commit the result."
    exit 2
  fi
  echo "[gen-api-types] check passed: types match committed copy."
else
  if [[ "$PREV_HASH" != "$NEW_HASH" ]]; then
    echo "[gen-api-types] updated $OUT_TS"
  else
    echo "[gen-api-types] no changes"
  fi
fi
