"""Duplicate-group review endpoints.

Lets the user check the dedup engine's choices: pick a different "kept"
image in a group, or dissolve a group entirely when the engine over-grouped.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import DuplicateGroup, Image
from sidecar.db.session import get_db

router = APIRouter()


def _img_thumb(img: Image) -> dict:
    # ?v=updated_at busts the HTTP cache once the underlying file is rewritten
    # (e.g. orient). Server-side thumb cache is also invalidated by mtime check.
    version = img.updated_at.isoformat() if img.updated_at else ""
    return {
        "id": img.id,
        "file_name": img.file_name,
        "width": img.width,
        "height": img.height,
        "file_size_kb": img.file_size_kb,
        "blur_score": img.blur_score,
        "relative_dir": img.relative_dir or "",
        "is_kept": bool(img.is_kept),
        "quality_status": img.quality_status,  # 'rejected' members are already in trash
        "thumbnail_url": f"/api/images/{img.id}/thumbnail?size=300&v={version}",
    }


@router.get("")
async def list_groups(
    project_id: str,
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    groups_q = (
        select(DuplicateGroup)
        .where(DuplicateGroup.project_id == project_id)
        .order_by(DuplicateGroup.image_count.desc(), DuplicateGroup.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    groups = (await db.execute(groups_q)).scalars().all()
    if not groups:
        return {"total": 0, "items": []}

    group_ids = [g.id for g in groups]
    members_q = (
        select(Image)
        .where(Image.dedup_group_id.in_(group_ids))
        .order_by(Image.is_kept.desc(), Image.width.desc().nulls_last())
    )
    members = (await db.execute(members_q)).scalars().all()

    grouped: dict[str, list[Image]] = {}
    for m in members:
        grouped.setdefault(m.dedup_group_id, []).append(m)

    # Total groups in the project (for pagination)
    total_row = await db.execute(
        select(DuplicateGroup).where(DuplicateGroup.project_id == project_id)
    )
    total = len(total_row.scalars().all())

    return {
        "total": total,
        "items": [
            {
                "id": g.id,
                "kept_image_id": g.kept_image_id,
                "image_count": g.image_count,
                # Members not yet processed: is_kept=False AND not already
                # rejected (i.e., still need a pass through accept-this-group).
                # Drives the "X 张可清理" badge so the toolbar reflects reality
                # after a partial run.
                "pending_count": sum(
                    1 for m in grouped.get(g.id, [])
                    if (not m.is_kept) and m.quality_status != "rejected"
                ),
                "avg_hamming_distance": float(g.avg_hamming_distance or 0.0),
                "created_at": g.created_at.isoformat() if g.created_at else None,
                "members": [_img_thumb(m) for m in grouped.get(g.id, [])],
            }
            for g in groups
        ],
    }


class SetKeptBody(BaseModel):
    image_id: str


@router.post("/{group_id}/set-kept")
async def set_kept(group_id: str, body: SetKeptBody, db: AsyncSession = Depends(get_db)):
    group = await db.get(DuplicateGroup, group_id)
    if not group:
        raise HTTPException(404, "Duplicate group not found")

    target = await db.get(Image, body.image_id)
    if not target or target.dedup_group_id != group_id:
        raise HTTPException(400, "Image not in this group")

    await db.execute(
        update(Image)
        .where(Image.dedup_group_id == group_id)
        .values(is_kept=False)
    )
    await db.execute(
        update(Image).where(Image.id == body.image_id).values(is_kept=True)
    )
    group.kept_image_id = body.image_id
    await db.commit()
    return {"ok": True, "kept_image_id": body.image_id}


@router.post("/{group_id}/dissolve")
async def dissolve(group_id: str, db: AsyncSession = Depends(get_db)):
    """Break the group — all members become 'kept', group row is deleted."""
    group = await db.get(DuplicateGroup, group_id)
    if not group:
        raise HTTPException(404, "Duplicate group not found")

    await db.execute(
        update(Image)
        .where(Image.dedup_group_id == group_id)
        .values(is_kept=True, dedup_group_id=None)
    )
    await db.delete(group)
    await db.commit()
    return {"ok": True}


class RemoveMemberBody(BaseModel):
    image_id: str


@router.post("/{group_id}/remove-member")
async def remove_member(group_id: str, body: RemoveMemberBody, db: AsyncSession = Depends(get_db)):
    """Take one image out of the group — keep it standalone, the group shrinks."""
    group = await db.get(DuplicateGroup, group_id)
    if not group:
        raise HTTPException(404, "Duplicate group not found")

    img = await db.get(Image, body.image_id)
    if not img or img.dedup_group_id != group_id:
        raise HTTPException(400, "Image not in this group")

    img.dedup_group_id = None
    img.is_kept = True

    group.image_count = max(1, (group.image_count or 1) - 1)
    if group.kept_image_id == body.image_id:
        # Promote first remaining member
        rows = await db.execute(
            select(Image).where(Image.dedup_group_id == group_id).limit(1)
        )
        replacement = rows.scalar_one_or_none()
        if replacement:
            group.kept_image_id = replacement.id
            await db.execute(
                update(Image).where(Image.id == replacement.id).values(is_kept=True)
            )

    # If group shrank to 1, dissolve it
    if group.image_count <= 1:
        remaining = await db.execute(
            select(Image).where(Image.dedup_group_id == group_id)
        )
        for m in remaining.scalars().all():
            m.dedup_group_id = None
            m.is_kept = True
        await db.delete(group)

    await db.commit()
    return {"ok": True}


# ── Bulk acceptance: send is_kept=False members to the trash (rejected) ──
#
# Two-phase safety: this only flips `quality_status='rejected'` so the user
# can review them in the trash tab and decide whether to permanently delete.
# Group rows are kept untouched so the user can still see the grouping.


class AcceptAllBody(BaseModel):
    project_id: str
    min_group_size: int | None = None  # only accept groups with ≥ N members


@router.post("/accept-all")
async def accept_all(body: AcceptAllBody, db: AsyncSession = Depends(get_db)):
    """Mark every is_kept=False image (across all groups) as rejected so it
    shows up in the trash tab. Reversible by un-rejecting in the trash."""
    # Find candidate ids first (so we can return a precise count)
    q = (
        select(Image.id)
        .where(Image.project_id == body.project_id)
        .where(Image.dedup_group_id.is_not(None))
        .where(Image.is_kept == False)  # noqa: E712
        .where(Image.quality_status != "rejected")
    )
    if body.min_group_size and body.min_group_size > 1:
        sub = (
            select(DuplicateGroup.id)
            .where(DuplicateGroup.project_id == body.project_id)
            .where(DuplicateGroup.image_count >= body.min_group_size)
        )
        q = q.where(Image.dedup_group_id.in_(sub))

    rows = await db.execute(q)
    ids = [r[0] for r in rows.all()]
    if not ids:
        return {"ok": True, "moved_to_trash": 0}

    # Batch in chunks of 500 to keep individual statements small
    CHUNK = 500
    for start in range(0, len(ids), CHUNK):
        chunk = ids[start:start + CHUNK]
        await db.execute(
            update(Image)
            .where(Image.id.in_(chunk))
            .values(quality_status="rejected", reject_reason="duplicate")
        )
        await db.commit()
    return {"ok": True, "moved_to_trash": len(ids)}


@router.post("/{group_id}/accept")
async def accept_group(group_id: str, db: AsyncSession = Depends(get_db)):
    """Apply the recommendation for ONE group: send all non-kept members to
    the trash. Group row is preserved so the kept image still shows the
    'has duplicates' badge for context."""
    group = await db.get(DuplicateGroup, group_id)
    if not group:
        raise HTTPException(404, "Duplicate group not found")

    rows = await db.execute(
        select(Image.id)
        .where(Image.dedup_group_id == group_id)
        .where(Image.is_kept == False)  # noqa: E712
        .where(Image.quality_status != "rejected")
    )
    ids = [r[0] for r in rows.all()]
    if not ids:
        return {"ok": True, "moved_to_trash": 0}

    await db.execute(
        update(Image)
        .where(Image.id.in_(ids))
        .values(quality_status="rejected", reject_reason="duplicate")
    )
    await db.commit()
    return {"ok": True, "moved_to_trash": len(ids)}
