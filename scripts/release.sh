#!/usr/bin/env bash
# 发版脚本：bump version + commit + tag + push + 等 CI 跑完
#
# 用法：
#   ./scripts/release.sh patch        # 0.1.1 → 0.1.2  (默认)
#   ./scripts/release.sh minor        # 0.1.1 → 0.2.0
#   ./scripts/release.sh major        # 0.1.1 → 1.0.0
#   ./scripts/release.sh 0.2.5        # 直接指定版本号
#   ./scripts/release.sh patch "修了个 X 的 bug"   # 带自定义提交信息
#
# 流程：
#   1. 沙盒检查（在 v0.2 分支、工作树干净、新 tag 不存在）
#   2. 改 apps/electron/package.json 和 package-lock.json 的 version
#   3. 拉远端最新（避免和别处 push 冲突）
#   4. commit + tag + push
#   5. 监视 GitHub Actions，跑完输出结果

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_JSON="$REPO_ROOT/apps/electron/package.json"
LOCK_JSON="$REPO_ROOT/package-lock.json"

cd "$REPO_ROOT"

# ── 颜色输出 ────────────────────────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

die() { red "✗ $*"; exit 1; }

# ── 入参解析 ────────────────────────────────────────────────────────────────
BUMP="${1:-patch}"
COMMIT_MSG="${2:-}"

# ── Sanity 检查 ─────────────────────────────────────────────────────────────
cyan "=== Sanity check ==="

[ -f "$PKG_JSON" ]  || die "找不到 $PKG_JSON"
[ -f "$LOCK_JSON" ] || die "找不到 $LOCK_JSON"

command -v git    >/dev/null || die "需要 git"
command -v jq     >/dev/null || die "需要 jq（macOS: brew install jq / Win: scoop install jq）"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "v0.2" ]; then
  die "必须在 v0.2 分支上发版（当前在 $current_branch）"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  red "✗ 工作树有未提交改动"
  git status --short
  die "请先 commit 或 stash 你的改动再发版"
fi

# ── 算新版本号 ──────────────────────────────────────────────────────────────
current_version=$(jq -r '.version' "$PKG_JSON")
echo "当前版本: $current_version"

case "$BUMP" in
  patch|minor|major)
    IFS='.' read -r major minor patch <<<"$current_version"
    case "$BUMP" in
      patch) patch=$((patch + 1)) ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      major) major=$((major + 1)); minor=0; patch=0 ;;
    esac
    new_version="${major}.${minor}.${patch}"
    ;;
  *)
    # 直接指定版本号（必须是 X.Y.Z 格式）
    if [[ ! "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]]; then
      die "版本号格式不对: $BUMP（应该像 0.1.2 或 0.2.0-beta.1）"
    fi
    new_version="$BUMP"
    ;;
esac

new_tag="v$new_version"
echo "新版本:   $new_version"
echo "新 tag:   $new_tag"

# ── 检查 tag 不能重复 ──────────────────────────────────────────────────────
if git rev-parse -q --verify "refs/tags/$new_tag" >/dev/null; then
  die "tag $new_tag 已存在（本地）"
fi

git fetch origin --tags --quiet
if git rev-parse -q --verify "refs/tags/$new_tag" >/dev/null; then
  die "tag $new_tag 已存在（远端）"
fi

# ── 拉远端最新 ──────────────────────────────────────────────────────────────
cyan "\n=== 拉远端最新 ==="
git pull --no-rebase origin v0.2

# ── 改 version ──────────────────────────────────────────────────────────────
cyan "\n=== Bumping version $current_version → $new_version ==="
# package.json
tmp=$(mktemp)
jq --arg v "$new_version" '.version = $v' "$PKG_JSON" >"$tmp"
mv "$tmp" "$PKG_JSON"

# package-lock.json — 改 root.packages."apps/electron".version
tmp=$(mktemp)
jq --arg v "$new_version" '.packages."apps/electron".version = $v' "$LOCK_JSON" >"$tmp"
mv "$tmp" "$LOCK_JSON"

green "✓ package.json + package-lock.json updated"

# ── 确认提交信息 ────────────────────────────────────────────────────────────
if [ -z "$COMMIT_MSG" ]; then
  COMMIT_MSG="$new_tag: 例行更新"
  yellow "（未提供提交信息，使用默认: \"$COMMIT_MSG\"）"
fi

full_msg="$new_tag: $COMMIT_MSG"
# 如果用户已经在自定义信息里带了 v0.x.x 前缀，避免重复
if [[ "$COMMIT_MSG" =~ ^v[0-9]+\. ]]; then
  full_msg="$COMMIT_MSG"
fi

# ── Commit + tag + push ────────────────────────────────────────────────────
cyan "\n=== Commit + tag + push ==="
git add "$PKG_JSON" "$LOCK_JSON"
git commit -m "$full_msg"
git tag "$new_tag"

echo "Pushing branch + tag to origin..."
git push origin v0.2
git push origin "$new_tag"

green "\n✓ 推送完成"
echo
echo "GitHub Actions 跑起来了，约 15 分钟。看进度："
echo "  https://github.com/Estrella9527/lintu/actions"
echo
echo "跑完后："
echo "  - 最新版下载: https://github.com/Estrella9527/lintu/releases/tag/$new_tag"
echo "  - OSS Win:    https://lintu-releases.oss-cn-hangzhou.aliyuncs.com/windows/latest.yml"
echo "  - OSS Mac:    https://lintu-releases.oss-cn-hangzhou.aliyuncs.com/mac/latest-mac.yml"
echo
echo "装着旧版本的客户端将在下次启动后 10 秒内开始静默拉新版。"

# ── 等 CI（可选） ──────────────────────────────────────────────────────────
if command -v gh >/dev/null && [ "${WAIT_CI:-1}" = "1" ]; then
  cyan "\n=== 等 CI 跑完（10-15 分钟，按 Ctrl+C 跳过） ==="
  sleep 10
  # 拿最新一次属于这个 tag 的 run id
  run_id=$(gh run list --repo Estrella9527/lintu --workflow build-installers.yml \
    --branch "$new_tag" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
  if [ -z "$run_id" ]; then
    yellow "找不到 tag run，可能还没启动 — 自己去 Actions 页看吧"
    exit 0
  fi
  gh run watch "$run_id" --repo Estrella9527/lintu --interval 30 || {
    red "✗ CI 失败 / 中断 — 去 Actions 页看日志"
    exit 1
  }
  green "✓ CI 全绿"

  echo ""
  echo "校验 OSS latest.yml 的版本字段..."
  oss_version=$(curl -s --max-time 10 \
    https://lintu-releases.oss-cn-hangzhou.aliyuncs.com/windows/latest.yml 2>/dev/null \
    | grep -E "^version:" | awk '{print $2}' || echo "")
  if [ "$oss_version" = "$new_version" ]; then
    green "✓ OSS Windows latest.yml: version=$oss_version"
  else
    yellow "⚠ OSS 上版本是 \"$oss_version\"，期望 \"$new_version\" — 可能 OSS 缓存还没刷新，等 1-2 分钟再看"
  fi
fi
