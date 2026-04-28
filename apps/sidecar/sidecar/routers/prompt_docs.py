"""Prompt document upload + listing.

Parsing logic lands in Sprint 2 (engines/prompt_parser.py); this module
handles upload, metadata, listing, and the post-parse "confirm import"
that flips parsed payload entries into prompts table rows.
"""
from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.config import WORKSPACE_DIR
from sidecar.db.models import Project, Prompt, PromptDoc, Task
from sidecar.db.session import get_db
from sidecar.engines.prompt_parser import get_progress_queue

router = APIRouter()

PROMPT_DOCS_DIR = WORKSPACE_DIR / "prompt_docs"
PROMPT_DOCS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_FORMATS = {"md", "markdown", "txt", "docx", "xlsx", "pdf"}


def _to_dict(d: PromptDoc) -> dict:
    return {
        "id": d.id,
        "filename": d.filename,
        "file_path": d.file_path,
        "format": d.format,
        "parse_status": d.parse_status,
        "parsed_count": d.parsed_count,
        "parsed_payload": d.parsed_payload,
        "parse_error": d.parse_error,
        "created_at": d.created_at.isoformat() if d.created_at else None,
        "updated_at": d.updated_at.isoformat() if d.updated_at else None,
    }


@router.get("")
async def list_docs(db: AsyncSession = Depends(get_db)):
    rows = await db.execute(select(PromptDoc).order_by(PromptDoc.created_at.desc()))
    return [_to_dict(d) for d in rows.scalars().all()]


@router.get("/{doc_id}")
async def get_doc(doc_id: str, db: AsyncSession = Depends(get_db)):
    doc = await db.get(PromptDoc, doc_id)
    if not doc:
        raise HTTPException(404, "PromptDoc not found")
    return _to_dict(doc)


@router.post("/upload")
async def upload_doc(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    name = file.filename or "upload"
    ext = Path(name).suffix.lstrip(".").lower()
    if ext not in ALLOWED_FORMATS:
        raise HTTPException(400, f"Unsupported format: {ext}")

    doc = PromptDoc(filename=name, file_path="", format=ext, parse_status="pending")
    db.add(doc)
    await db.flush()  # need id before saving file

    target = PROMPT_DOCS_DIR / f"{doc.id}_{name}"
    with target.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    doc.file_path = str(target)
    await db.commit()
    await db.refresh(doc)
    return _to_dict(doc)


class ParseBody(BaseModel):
    project_id: Optional[str] = None  # falls back to first project


class ConfirmBody(BaseModel):
    selected_indexes: Optional[list[int]] = None  # if None, import all parsed entries


@router.get("/{doc_id}/stream")
async def stream_parse(doc_id: str):
    """SSE stream of parse progress: phase events + per-entry deltas.

    Stays open until the parser emits `phase: complete` or `phase: failed`.
    Sends a comment keep-alive every 25s during quiet periods.
    """
    queue = get_progress_queue(doc_id)

    async def gen():
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=25)
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
                if event.get("phase") in ("complete", "failed"):
                    break
            except asyncio.TimeoutError:
                yield ":keepalive\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{doc_id}/parse")
async def parse_doc(doc_id: str, body: ParseBody, db: AsyncSession = Depends(get_db)):
    """Kick off the parse_prompt task. Returns the task id for SSE follow-up."""
    doc = await db.get(PromptDoc, doc_id)
    if not doc:
        raise HTTPException(404, "PromptDoc not found")

    project_id = body.project_id
    if not project_id:
        first = await db.execute(select(Project).limit(1))
        proj = first.scalar_one_or_none()
        if not proj:
            raise HTTPException(400, "No project exists; create one first or pass project_id")
        project_id = proj.id

    task = Task(
        project_id=project_id,
        type="parse_prompt",
        status="queued",
        parameters=json.dumps({"doc_id": doc_id}),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return {"task_id": task.id, "doc_id": doc_id}


@router.post("/{doc_id}/confirm")
async def confirm_doc(doc_id: str, body: ConfirmBody, db: AsyncSession = Depends(get_db)):
    doc = await db.get(PromptDoc, doc_id)
    if not doc:
        raise HTTPException(404, "PromptDoc not found")
    if doc.parse_status != "success" or not doc.parsed_payload:
        raise HTTPException(400, "Document not parsed yet")

    entries = list(doc.parsed_payload)
    if body.selected_indexes is not None:
        entries = [entries[i] for i in body.selected_indexes if 0 <= i < len(entries)]

    created: list[dict] = []
    for e in entries:
        p = Prompt(
            name=e.get("name") or "Untitled",
            category=e.get("category") or "imported",
            content=e.get("content") or "",
            task_type=e.get("task_type"),
            negative_prompt=e.get("negative_prompt"),
            tags=e.get("tags"),
            source="imported",
            source_doc_id=doc.id,
            is_active=True,
        )
        db.add(p)
        await db.flush()
        created.append({"id": p.id, "name": p.name})

    await db.commit()
    return {"imported": len(created), "items": created}


@router.delete("/{doc_id}")
async def delete_doc(doc_id: str, db: AsyncSession = Depends(get_db)):
    doc = await db.get(PromptDoc, doc_id)
    if not doc:
        raise HTTPException(404, "PromptDoc not found")
    try:
        Path(doc.file_path).unlink(missing_ok=True)
    except OSError:
        pass
    await db.delete(doc)
    await db.commit()
    return {"ok": True}
