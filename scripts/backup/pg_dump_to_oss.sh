#!/usr/bin/env bash
# 灵图云端 PG 每日备份 → 加密 → 推 OSS。
#
# 部署目标：ECS 192.0.2.1（api.example.com）
#
# 用法：
#   bash pg_dump_to_oss.sh                  # 走 .env 默认配置
#   bash pg_dump_to_oss.sh --dry-run        # 只 dump 到本地，不上传不加密
#
# crontab（每日凌晨 03:00 跑）：
#   0 3 * * * /opt/lintu/scripts/backup/pg_dump_to_oss.sh \
#                 >> /var/log/lintu/backup.log 2>&1
#
# 环境变量（在 /opt/lintu/scripts/backup/.env，chmod 600）：
#   LINTU_PG_HOST          PG host（默认 127.0.0.1）
#   LINTU_PG_PORT          PG port（默认 5432）
#   LINTU_PG_USER          PG user
#   LINTU_PG_DB            PG database
#   PGPASSWORD             PG 密码（pg_dump 自动读）
#   LINTU_BACKUP_KEY       openssl 对称加密密钥（任意强字符串）
#   LINTU_BACKUP_OSS_BUCKET  目标 bucket
#   LINTU_BACKUP_OSS_PATH    路径前缀（默认 lintu-backups/pg）
#   LINTU_BACKUP_LOCAL_DIR   本地暂存目录（默认 /var/backups/lintu）
#   LINTU_BACKUP_RETAIN_DAYS 本地保留天数（默认 7；OSS 由 lifecycle 管理）
#
# 退出码：
#   0 成功
#   1 配置缺失 / pg_dump 失败 / 上传失败
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# ── 加载环境变量 ──────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

PG_HOST="${LINTU_PG_HOST:-127.0.0.1}"
PG_PORT="${LINTU_PG_PORT:-5432}"
PG_USER="${LINTU_PG_USER:-}"
PG_DB="${LINTU_PG_DB:-}"
LOCAL_DIR="${LINTU_BACKUP_LOCAL_DIR:-/var/backups/lintu}"
OSS_BUCKET="${LINTU_BACKUP_OSS_BUCKET:-}"
OSS_PATH="${LINTU_BACKUP_OSS_PATH:-lintu-backups/pg}"
RETAIN_DAYS="${LINTU_BACKUP_RETAIN_DAYS:-7}"

# ── 校验必填 ──────────────────────────────────────────────────────────────
if [[ -z "$PG_USER" || -z "$PG_DB" ]]; then
  echo "[backup] ERROR: LINTU_PG_USER + LINTU_PG_DB 必填（在 .env）" >&2
  exit 1
fi
if [[ "$DRY_RUN" == "false" ]]; then
  if [[ -z "${LINTU_BACKUP_KEY:-}" ]]; then
    echo "[backup] ERROR: LINTU_BACKUP_KEY 必填（生产环境必须加密）" >&2
    exit 1
  fi
  if [[ -z "$OSS_BUCKET" ]]; then
    echo "[backup] ERROR: LINTU_BACKUP_OSS_BUCKET 必填" >&2
    exit 1
  fi
fi

# ── 准备路径 ──────────────────────────────────────────────────────────────
mkdir -p "$LOCAL_DIR"
TS="$(date +%Y%m%d_%H%M)"
DATE_PATH="$(date +%Y/%m)/$(date +%d-%H%M)"
OUT_NAME="lintu-${PG_DB}-${TS}.sql.gz"
OUT_LOCAL="$LOCAL_DIR/$OUT_NAME"
OUT_LOCAL_ENC="$OUT_LOCAL.enc"

START_TS=$(date +%s)
echo "[backup] $(date -Iseconds) start: db=$PG_DB host=$PG_HOST"

# ── pg_dump → gzip ────────────────────────────────────────────────────────
# -Fc = custom format（pg_restore 友好；比 plain SQL 小 3-5x）
# 不加 -Fc 是为了 dump 完直接 gzip 流式管道；做小型库这样足够。如果库 >10GB
# 且想要 parallel restore，把 -Fc 加回来并改成 .dump 后缀。
PG_DUMP_OPTS=(
  --host="$PG_HOST"
  --port="$PG_PORT"
  --username="$PG_USER"
  --no-owner --no-acl
  --clean --if-exists
)
echo "[backup] dumping..."
if ! pg_dump "${PG_DUMP_OPTS[@]}" "$PG_DB" | gzip -9 > "$OUT_LOCAL"; then
  echo "[backup] ERROR: pg_dump failed" >&2
  rm -f "$OUT_LOCAL"
  exit 1
fi
RAW_SIZE=$(stat -c%s "$OUT_LOCAL" 2>/dev/null || stat -f%z "$OUT_LOCAL")
echo "[backup] dump size: $(numfmt --to=iec "$RAW_SIZE")"

# ── 加密 ──────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
  echo "[backup] DRY-RUN: 跳过加密 + 上传，文件留在 $OUT_LOCAL"
  exit 0
fi

echo "[backup] encrypting..."
# -pbkdf2 是 OpenSSL 1.1+ 的强制安全标志，避免 weak key derivation。
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$OUT_LOCAL" -out "$OUT_LOCAL_ENC" \
  -pass env:LINTU_BACKUP_KEY
rm -f "$OUT_LOCAL"   # 删除未加密版本，永远不留磁盘

# ── 上传 OSS ──────────────────────────────────────────────────────────────
OSS_KEY="${OSS_PATH}/${DATE_PATH}/${OUT_NAME}.enc"
OSS_URL="oss://${OSS_BUCKET}/${OSS_KEY}"

echo "[backup] uploading to $OSS_URL ..."
if ! ossutil cp "$OUT_LOCAL_ENC" "$OSS_URL" --force >/dev/null; then
  echo "[backup] ERROR: ossutil 上传失败（检查 ossutil 是否配置 + bucket 权限）" >&2
  exit 1
fi
ENC_SIZE=$(stat -c%s "$OUT_LOCAL_ENC" 2>/dev/null || stat -f%z "$OUT_LOCAL_ENC")

# ── 本地保留策略 ──────────────────────────────────────────────────────────
# OSS 那边的 lifecycle 由 bucket 配置（推荐：14d 标准 → 30d 低频 → 365d 归档）
find "$LOCAL_DIR" -name "lintu-${PG_DB}-*.sql.gz.enc" -mtime "+${RETAIN_DAYS}" -delete

ELAPSED=$(( $(date +%s) - START_TS ))
echo "[backup] $(date -Iseconds) DONE: ${ELAPSED}s, encrypted size $(numfmt --to=iec "$ENC_SIZE"), uploaded to $OSS_URL"
