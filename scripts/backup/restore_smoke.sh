#!/usr/bin/env bash
# 灵图备份还原冒烟测试 — 每周日凌晨 04:00 跑一次，验证「最新 PG 备份」可解密
# 可还原。这是备份系统的"心跳"：能 dump 不代表能 restore，必须周期验证。
#
# 用法：
#   bash restore_smoke.sh                  # 默认拉最新备份还原到 lintu_smoke 临时库
#   bash restore_smoke.sh --target staging # 还原到 lintu_staging（需提前 createdb）
#   bash restore_smoke.sh --keep           # 还原后保留临时库（默认验完即删）
#
# crontab：
#   0 4 * * 0 /opt/lintu/scripts/backup/restore_smoke.sh \
#                 >> /var/log/lintu/restore-smoke.log 2>&1
#
# 校验逻辑：
#   1. 找 OSS 上最新的备份文件
#   2. 下载 + 解密
#   3. createdb lintu_smoke_<ts>
#   4. gzip -d | psql restore
#   5. 跑 SELECT count(*) FROM images, projects 等关键表
#   6. dropdb（除非 --keep）
#
# 任一步失败 → 退出码非 0，cron 邮件告警 / 飞书 hook 接管
set -euo pipefail

TARGET=""
KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --keep)   KEEP=true; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

PG_HOST="${LINTU_PG_HOST:-127.0.0.1}"
PG_PORT="${LINTU_PG_PORT:-5432}"
PG_USER="${LINTU_PG_USER:-}"
PG_DB="${LINTU_PG_DB:-}"
OSS_BUCKET="${LINTU_BACKUP_OSS_BUCKET:-}"
OSS_PATH="${LINTU_BACKUP_OSS_PATH:-lintu-backups/pg}"

if [[ -z "$LINTU_BACKUP_KEY" || -z "$OSS_BUCKET" || -z "$PG_USER" || -z "$PG_DB" ]]; then
  echo "[restore-smoke] ERROR: 必填环境变量缺失（见 .env）" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t lintu-restore-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

START_TS=$(date +%s)
echo "[restore-smoke] $(date -Iseconds) start"

# ── 1. 找最新备份 ─────────────────────────────────────────────────────────
echo "[restore-smoke] 列出 oss://${OSS_BUCKET}/${OSS_PATH}/ 最新文件..."
LATEST="$(ossutil ls -s "oss://${OSS_BUCKET}/${OSS_PATH}/" --recursive \
  | grep "lintu-${PG_DB}-" | grep "\.enc$" \
  | awk '{print $NF}' | sort | tail -1)"
if [[ -z "$LATEST" ]]; then
  echo "[restore-smoke] ERROR: 找不到任何备份文件" >&2
  exit 1
fi
echo "[restore-smoke] 最新备份：$LATEST"

# ── 2. 下载 + 解密 ────────────────────────────────────────────────────────
ENC_LOCAL="$TMP_DIR/backup.sql.gz.enc"
GZ_LOCAL="$TMP_DIR/backup.sql.gz"

echo "[restore-smoke] 下载..."
ossutil cp "$LATEST" "$ENC_LOCAL" --force >/dev/null

echo "[restore-smoke] 解密..."
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in "$ENC_LOCAL" -out "$GZ_LOCAL" \
  -pass env:LINTU_BACKUP_KEY

# ── 3. createdb ───────────────────────────────────────────────────────────
if [[ -z "$TARGET" ]]; then
  TARGET="lintu_smoke_$(date +%Y%m%d%H%M%S)"
fi
echo "[restore-smoke] 还原到临时库 $TARGET..."
PG_OPTS=(--host="$PG_HOST" --port="$PG_PORT" --username="$PG_USER")

# 先确保库不存在（再删 + 创建是幂等做法）
psql "${PG_OPTS[@]}" --dbname=postgres -c "DROP DATABASE IF EXISTS \"$TARGET\";" >/dev/null
psql "${PG_OPTS[@]}" --dbname=postgres -c "CREATE DATABASE \"$TARGET\";" >/dev/null

# ── 4. gzip -d | psql ────────────────────────────────────────────────────
echo "[restore-smoke] 跑 psql restore..."
gunzip -c "$GZ_LOCAL" | psql "${PG_OPTS[@]}" --dbname="$TARGET" --quiet --single-transaction

# ── 5. 健康度校验 ────────────────────────────────────────────────────────
echo "[restore-smoke] 校验关键表 row count..."
ROW_REPORT="$(psql "${PG_OPTS[@]}" --dbname="$TARGET" -At -c "
  SELECT 'projects=' || COUNT(*) FROM projects;
  SELECT 'images='   || COUNT(*) FROM images;
  SELECT 'tags='     || COUNT(*) FROM tags;
")"
echo "$ROW_REPORT" | sed 's/^/[restore-smoke] /'

# 至少 projects 不应该 = 0；如果是空库说明备份内容有问题
PROJECT_COUNT="$(echo "$ROW_REPORT" | grep '^projects=' | cut -d= -f2)"
if [[ -z "$PROJECT_COUNT" || "$PROJECT_COUNT" -lt 1 ]]; then
  echo "[restore-smoke] ERROR: 还原后 projects=0，备份可能是损坏的" >&2
  exit 1
fi

# ── 6. 清理 ──────────────────────────────────────────────────────────────
if [[ "$KEEP" == "true" ]]; then
  echo "[restore-smoke] --keep 指定，保留 $TARGET（手动 dropdb 清理）"
else
  echo "[restore-smoke] dropdb $TARGET"
  psql "${PG_OPTS[@]}" --dbname=postgres -c "DROP DATABASE IF EXISTS \"$TARGET\";" >/dev/null
fi

ELAPSED=$(( $(date +%s) - START_TS ))
echo "[restore-smoke] $(date -Iseconds) PASS: ${ELAPSED}s"
