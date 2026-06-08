"""一次性把本地 cloud_sync_jobs 里 pending 的任务推到云端并标记 done。

用于运行中 sidecar 不在/worker 没跑、但又想立刻把积压同步掉的场景(#225)。
复用 cloud_sync_worker 的 payload 构造与发送逻辑,保证与常规同步语义一致。

    cd apps/sidecar
    LINTU_CLOUD_SYNC_URL=... LINTU_INTERNAL_SYNC_TOKEN=... \
        uv run python scripts/drain_pending_sync.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from sqlalchemy import select, update  # noqa: E402

from sidecar.config import LINTU_CLOUD_SYNC_URL, LINTU_INTERNAL_SYNC_TOKEN  # noqa: E402
from sidecar.db.models import CloudSyncJob  # noqa: E402
from sidecar.db.session import async_session  # noqa: E402
from sidecar.scheduler.cloud_sync_worker import cloud_sync_worker  # noqa: E402

IMG_CHUNK = 50  # 图片带 embedding,单次别太大


async def _mark(ids: list[int], status: str, err: str | None = None) -> None:
    async with async_session() as db:
        await db.execute(
            update(CloudSyncJob).where(CloudSyncJob.id.in_(ids))
            .values(status=status, error=err)
        )
        await db.commit()


async def main() -> None:
    if not LINTU_CLOUD_SYNC_URL or not LINTU_INTERNAL_SYNC_TOKEN:
        print("ERROR: LINTU_CLOUD_SYNC_URL / LINTU_INTERNAL_SYNC_TOKEN 未设置", file=sys.stderr)
        sys.exit(2)

    async with async_session() as db:
        jobs = (await db.execute(
            select(CloudSyncJob).where(CloudSyncJob.status == "pending")
            .order_by(CloudSyncJob.id)
        )).scalars().all()

    if not jobs:
        print("没有 pending 任务")
        return

    # 按 (entity_type, op) 分组;同组内再按 IMG_CHUNK 切块(images 才需要)
    groups: dict[tuple, list[CloudSyncJob]] = {}
    for j in jobs:
        groups.setdefault((j.entity_type, j.op), []).append(j)

    print(f"待推送 {len(jobs)} 条,分 {len(groups)} 组")
    headers = {"Authorization": f"Bearer {LINTU_INTERNAL_SYNC_TOKEN}"}
    timeout = httpx.Timeout(connect=10, read=120, write=120, pool=10)
    ok = fail = 0
    async with httpx.AsyncClient(headers=headers, timeout=timeout) as client:
        for (etype, op), js in groups.items():
            chunk_sz = IMG_CHUNK if etype == "image" else len(js)
            for i in range(0, len(js), chunk_sz):
                chunk = js[i:i + chunk_sz]
                try:
                    await cloud_sync_worker._send_chunk(client, etype, op, chunk)
                    await _mark([j.id for j in chunk], "done")
                    ok += len(chunk)
                    print(f"  {etype}/{op}: +{len(chunk)} done ({ok}/{len(jobs)})", flush=True)
                except Exception as e:
                    await _mark([j.id for j in chunk], "failed", str(e)[:300])
                    fail += len(chunk)
                    print(f"  {etype}/{op}: FAILED {len(chunk)} — {str(e)[:160]}", flush=True)

    print(f"\n完成: done={ok} failed={fail}")


if __name__ == "__main__":
    asyncio.run(main())
