"""Per-project sliding window of recently-shown image_ids.

When UGC text is repetitive (same auto-generated note rendered for many
users), even with `randomness` + `exclude_ids` the same set of images
keeps surfacing across calls because the recall pool is finite and the
top scores are deterministic given the same query.

This module gives the server a memory: every match call appends its
returned image_ids to a per-project deque capped at N. The next match
call against the same project automatically excludes whatever is
already in the deque, regardless of who's calling. The result is a
"freshness rotation" guaranteed across UGC clients without any
client-side coordination.

In-memory only — no DB write, no cloud sync. State resets on sidecar
restart, which is fine: "recently" is a UX nicety, not a contract.

Concurrency: asyncio single-loop, all access from request handlers ⇒
no locks needed for the deque mutations themselves. Reading is just
list(deque) so it's a snapshot.
"""
from __future__ import annotations

from collections import deque
from typing import Iterable

# Per-project deque. Key = project_id; None project_id means "global / no
# project scope" (for legacy single-shard recall). Value = deque of
# image_id strings, oldest at the left, newest at the right.
_buffers: dict[str | None, deque[str]] = {}

# Default size used until config-driven size is read; the route handler
# overrides per-call by passing `cap` explicitly.
_DEFAULT_CAP = 20


def get_recent_ids(project_id: str | None) -> list[str]:
    """Snapshot of the project's currently-cooling-down image_ids.
    Empty list when nothing has been served for that project yet."""
    buf = _buffers.get(project_id)
    return list(buf) if buf else []


def record_served(project_id: str | None, image_ids: Iterable[str], cap: int = _DEFAULT_CAP) -> None:
    """Append served image_ids to the project's cooldown buffer, evicting
    older entries beyond `cap`. cap=0 disables the cooldown (we still
    no-op cleanly so callers don't need to branch).
    """
    if cap is None or cap <= 0:
        return
    ids = [i for i in image_ids if i]
    if not ids:
        return
    buf = _buffers.get(project_id)
    if buf is None or buf.maxlen != cap:
        # First insert OR cap changed since last write — rebuild deque
        # preserving recent entries.
        prior = list(buf) if buf else []
        buf = deque(prior, maxlen=cap)
        _buffers[project_id] = buf
    for img_id in ids:
        # Keep each ID at most once in the window; if it's already there,
        # move-to-end (i.e. refresh its recency).
        try:
            buf.remove(img_id)
        except ValueError:
            pass
        buf.append(img_id)


def reset(project_id: str | None = None) -> int:
    """Clear the cooldown for one project (or everything when arg omitted).
    Returns the number of entries that were dropped — useful for ops
    endpoints that want to confirm the reset happened."""
    if project_id is None:
        n = sum(len(b) for b in _buffers.values())
        _buffers.clear()
        return n
    buf = _buffers.pop(project_id, None)
    return len(buf) if buf else 0
