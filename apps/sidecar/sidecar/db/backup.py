"""SQLite 备份与迁移安全网。

灵图的全部业务数据(图库、策略、审核、风格档案)都在客户本机的单个
`lintu.db` 里。两类事故会一次性毁掉它:

  1. **迁移脚本 bug**:alembic upgrade 跑一半崩溃 / 误 DROP,留下半残 schema。
  2. **进程异常**:OOM / SIGKILL 让 WAL 文件损坏。

本模块提供两道防线:

  - `backup_before_migration()`:迁移前用 SQLite 在线备份 API(`Connection.backup`)
    做一份一致性快照,迁移失败时 `restore_from()` 还原。在线备份比 `shutil.copy`
    安全 —— 它能正确处理 WAL,拷出的是事务一致的状态。
  - `daily_snapshot()`:每日一份轮转快照(保留最近 N 份),挡住"用了三个月才发现
    某天数据被误删"这类慢性事故。

快照都放在 `DATA_DIR/backups/` 下,纯本地。云端加密备份是后续工作(账号级
云端化),但本地这层零成本、先把最坏情况兜住。
"""
from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path

from sidecar.config import DATA_DIR, DB_PATH

logger = logging.getLogger(__name__)

BACKUP_DIR = DATA_DIR / "backups"
DAILY_KEEP = 7          # 每日快照保留份数
PRE_MIGRATION_KEEP = 5  # 迁移前快照保留份数


def _ensure_dir() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def _online_backup(src: Path, dst: Path) -> None:
    """用 SQLite 在线备份 API 拷一份事务一致的快照(正确处理 WAL)。"""
    src_conn = sqlite3.connect(str(src))
    try:
        dst_conn = sqlite3.connect(str(dst))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


def _rotate(prefix: str, keep: int) -> None:
    """按文件名时间戳保留最近 keep 份,删掉更旧的。"""
    snaps = sorted(BACKUP_DIR.glob(f"{prefix}-*.db"))
    for old in snaps[:-keep] if keep > 0 else snaps:
        try:
            old.unlink()
        except OSError as e:
            logger.warning("rotate: 删除旧快照失败 %s: %s", old, e)


def backup_before_migration() -> Path | None:
    """迁移前快照。返回快照路径(失败返回 None,不阻断启动)。"""
    if not Path(DB_PATH).exists():
        return None
    _ensure_dir()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = BACKUP_DIR / f"pre-migration-{stamp}.db"
    try:
        _online_backup(Path(DB_PATH), dst)
        _rotate("pre-migration", PRE_MIGRATION_KEEP)
        logger.info("迁移前已备份数据库 → %s", dst)
        return dst
    except Exception as e:
        # 备份失败不应阻断启动,但要大声告警 —— 此时迁移没有安全网。
        logger.error("迁移前备份失败(本次迁移无回滚保护): %s", e)
        return None


def restore_from(snapshot: Path) -> bool:
    """从快照还原(迁移失败时调用)。还原前把损坏库改名留证。"""
    if not snapshot or not snapshot.exists():
        logger.error("还原失败:快照不存在 %s", snapshot)
        return False
    try:
        broken = Path(str(DB_PATH) + f".broken-{time.strftime('%Y%m%d-%H%M%S')}")
        if Path(DB_PATH).exists():
            Path(DB_PATH).rename(broken)
            logger.warning("迁移失败,损坏库已留存 → %s", broken)
        # WAL/SHM 残留一并清掉,避免和还原的库不一致
        for suffix in ("-wal", "-shm"):
            p = Path(str(DB_PATH) + suffix)
            if p.exists():
                p.unlink(missing_ok=True)
        _online_backup(snapshot, Path(DB_PATH))
        logger.info("已从快照还原数据库 ← %s", snapshot)
        return True
    except Exception as e:
        logger.error("从快照还原失败 %s: %s", snapshot, e)
        return False


def daily_snapshot() -> Path | None:
    """每日一份轮转快照(同一天重复调用会覆盖当天那份)。"""
    if not Path(DB_PATH).exists():
        return None
    _ensure_dir()
    day = time.strftime("%Y%m%d")
    dst = BACKUP_DIR / f"daily-{day}.db"
    try:
        _online_backup(Path(DB_PATH), dst)
        _rotate("daily", DAILY_KEEP)
        return dst
    except Exception as e:
        logger.warning("每日快照失败: %s", e)
        return None
