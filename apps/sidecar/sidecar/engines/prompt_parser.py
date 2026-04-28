"""Prompt-doc parsing engine — task_type='parse_prompt'.

Workflow per document:
  1. Load PromptDoc by id, mark parse_status='parsing'
  2. Read & extract raw text from md/txt/docx/xlsx/pdf
     (PDFs fall back to vision OCR if the text layer is too thin)
  3. Stream the LLM call; emit per-chunk + per-entry progress events
  4. Persist parsed_payload + parse_status='success'

Per-doc progress queues let the UI subscribe via SSE
(`GET /api/prompt-docs/{doc_id}/stream`) and watch each phase land:

  phase: extracting | ocr_page | calling_llm | chunk | entry | complete | failed
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import update

from sidecar.db.models import PromptDoc, Task
from sidecar.db.session import async_session
from sidecar.engines._json_streamer import JsonObjectStreamer
from sidecar.providers.registry import get_parser_provider_target

logger = logging.getLogger(__name__)

PDF_TEXT_MIN_CHARS = 100
PDF_OCR_MAX_PAGES = 20

# Chunk-level back-pressure: cap raw text we forward to the UI so a chatty
# model can't flood the SSE channel; we still keep the full content for
# JSON streaming / logging.
UI_CHUNK_TAIL_CHARS = 200


SYSTEM_PROMPT = """你是提示词结构化专家。用户会给你一段包含多条 AI 图片生成提示词的文档，
请提取出每条 prompt，输出 JSON 数组，每项包含:
- name: 简短命名（≤10字）
- content: prompt 正文
- category: 从 [风格/场景/营销/季节/其他] 中选一个
- task_type: 从 [style/outpaint/seasonal/inpaint/custom] 中选一个
- tags: 主题标签数组
- negative_prompt: 反向提示词（若文档有提供，否则留空字符串）

只输出 JSON 数组，不要 Markdown 代码块、不要其它解释文字。
若文档完全没有可识别的 prompt，输出空数组 []。
"""


# ── Per-doc progress queues (subscribed by SSE endpoint) ────────────────────

_progress_queues: dict[str, asyncio.Queue] = {}


def get_progress_queue(doc_id: str) -> asyncio.Queue:
    if doc_id not in _progress_queues:
        _progress_queues[doc_id] = asyncio.Queue()
    return _progress_queues[doc_id]


async def _emit(doc_id: str, event: dict[str, Any]) -> None:
    q = _progress_queues.get(doc_id)
    if q is not None:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass


# ── Format readers ─────────────────────────────────────────────────────────


def _read_md_or_txt(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def _read_docx(path: Path) -> str:
    from docx import Document
    doc = Document(str(path))
    parts: list[str] = []
    for para in doc.paragraphs:
        if para.text.strip():
            parts.append(para.text)
    for table in doc.tables:
        for row in table.rows:
            row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
            if row_text:
                parts.append(row_text)
    return "\n".join(parts)


def _read_xlsx(path: Path) -> str:
    from openpyxl import load_workbook
    wb = load_workbook(filename=str(path), read_only=True, data_only=True)
    parts: list[str] = []
    for sheet in wb.worksheets:
        parts.append(f"# Sheet: {sheet.title}")
        for row in sheet.iter_rows(values_only=True):
            cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def _read_pdf_text(path: Path) -> str:
    import fitz
    parts: list[str] = []
    with fitz.open(str(path)) as doc:
        for page in doc:
            txt = page.get_text("text") or ""
            if txt.strip():
                parts.append(txt)
    return "\n".join(parts).strip()


def _render_pdf_pages_png(path: Path, max_pages: int = PDF_OCR_MAX_PAGES) -> list[bytes]:
    import fitz
    pages: list[bytes] = []
    with fitz.open(str(path)) as doc:
        n = min(len(doc), max_pages)
        for i in range(n):
            page = doc.load_page(i)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            pages.append(pix.tobytes("png"))
    return pages


async def _read_pdf(path: Path, doc_id: str) -> str:
    text = _read_pdf_text(path)
    await _emit(doc_id, {"phase": "extracted_text", "chars": len(text)})
    if len(text) >= PDF_TEXT_MIN_CHARS:
        return text
    pages = _render_pdf_pages_png(path)
    await _emit(doc_id, {"phase": "rendered_pages", "pages": len(pages)})
    if not pages:
        return text
    ocr = await _ocr_pages_with_vision(doc_id, pages)
    return (text + "\n\n" + ocr).strip()


# ── Vision OCR (PDF) ───────────────────────────────────────────────────────


_OCR_INSTRUCTION = (
    "请把这页 PDF 中所有可见的文字、表格、列表内容完整转写成纯文本，保留段落和编号结构。"
    "不要总结、不要翻译、不要增加任何解释。如果页面没有文字，请只回复『(空白页)』。"
)


async def _ocr_pages_with_vision(doc_id: str, pages: list[bytes]) -> str:
    target = get_parser_provider_target()
    await _emit(doc_id, {
        "phase": "ocr_start",
        "provider": target["name"],
        "model": target.get("model"),
        "total_pages": len(pages),
    })
    if target["type"] == "openai_compat":
        return await _ocr_via_openai_compat(doc_id, target, pages)
    if target["type"] == "gemini":
        return await _ocr_via_gemini(doc_id, target, pages)
    raise RuntimeError(f"Unknown provider type: {target['type']}")


async def _ocr_via_openai_compat(doc_id: str, target: dict, pages: list[bytes]) -> str:
    base = target["base_url"].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    url = base + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {target['api_key']}",
        "Content-Type": "application/json",
    }
    out: list[str] = []
    async with httpx.AsyncClient(timeout=180) as client:
        for idx, png in enumerate(pages):
            await _emit(doc_id, {
                "phase": "ocr_page", "page": idx + 1, "total": len(pages),
            })
            b64 = base64.b64encode(png).decode()
            body = {
                "model": target.get("model") or "gpt-4o-mini",
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _OCR_INSTRUCTION},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }],
                "temperature": 0.1,
            }
            try:
                resp = await client.post(url, headers=headers, json=body)
                resp.raise_for_status()
                txt = resp.json()["choices"][0]["message"]["content"] or ""
            except Exception as e:
                logger.warning("Vision OCR page %d failed: %s", idx + 1, e)
                txt = ""
                await _emit(doc_id, {"phase": "ocr_page_failed", "page": idx + 1, "error": str(e)})
            out.append(f"--- Page {idx + 1} ---\n{txt.strip()}")
    return "\n\n".join(out)


async def _ocr_via_gemini(doc_id: str, target: dict, pages: list[bytes]) -> str:
    import google.generativeai as genai
    genai.configure(api_key=target["api_key"])
    model = genai.GenerativeModel(target.get("model") or "gemini-2.0-flash")
    out: list[str] = []
    for idx, png in enumerate(pages):
        await _emit(doc_id, {"phase": "ocr_page", "page": idx + 1, "total": len(pages)})
        try:
            resp = await model.generate_content_async([
                _OCR_INSTRUCTION,
                {"mime_type": "image/png", "data": png},
            ])
            txt = (resp.text or "").strip()
        except Exception as e:
            logger.warning("Gemini OCR page %d failed: %s", idx + 1, e)
            await _emit(doc_id, {"phase": "ocr_page_failed", "page": idx + 1, "error": str(e)})
            txt = ""
        out.append(f"--- Page {idx + 1} ---\n{txt}")
    return "\n\n".join(out)


async def _extract_text(path: Path, fmt: str, doc_id: str) -> str:
    fmt = fmt.lower()
    if fmt in ("md", "markdown", "txt"):
        return _read_md_or_txt(path)
    if fmt == "docx":
        return _read_docx(path)
    if fmt == "xlsx":
        return _read_xlsx(path)
    if fmt == "pdf":
        return await _read_pdf(path, doc_id)
    raise ValueError(f"Unsupported format: {fmt}")


# ── LLM streaming ──────────────────────────────────────────────────────────


async def _call_llm_streaming(doc_id: str, text: str) -> list[dict]:
    """Stream the LLM response; emit per-chunk + per-entry events.

    Returns the cleaned list of entries when the stream finishes.
    """
    target = get_parser_provider_target()
    await _emit(doc_id, {
        "phase": "llm_start",
        "provider": target["name"],
        "model": target.get("model"),
        "input_chars": len(text),
    })
    if target["type"] == "openai_compat":
        return await _stream_openai_compat(doc_id, target, text)
    if target["type"] == "gemini":
        return await _stream_gemini(doc_id, target, text)
    raise RuntimeError(f"Unknown provider type: {target['type']}")


async def _stream_openai_compat(doc_id: str, target: dict, text: str) -> list[dict]:
    base = target["base_url"].rstrip("/")
    if not base.endswith("/v1"):
        base = base + "/v1"
    url = base + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {target['api_key']}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    body = {
        "model": target.get("model") or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text[:80000]},
        ],
        "temperature": 0.2,
        "stream": True,
    }

    streamer = JsonObjectStreamer()
    accumulated: list[str] = []
    entries: list[dict] = []
    # Heartbeat so the SSE consumer doesn't time out during long token streams.
    last_heartbeat = asyncio.get_event_loop().time()

    async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=600, write=60, pool=60)) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            if resp.status_code >= 400:
                raw = (await resp.aread()).decode("utf-8", errors="replace")
                raise RuntimeError(f"upstream {resp.status_code}: {raw[:500]}")
            async for line in resp.aiter_lines():
                line = (line or "").strip()
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    obj = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = (obj.get("choices") or [{}])[0].get("delta", {})
                content = delta.get("content") or ""
                if not content:
                    continue
                accumulated.append(content)

                # Forward a trimmed tail to the UI for transparency
                tail = content[-UI_CHUNK_TAIL_CHARS:]
                await _emit(doc_id, {"phase": "chunk", "text": tail})

                # Try to extract any complete top-level objects
                for raw_obj in streamer.feed(content):
                    cleaned = _coerce_one(raw_obj)
                    if cleaned:
                        entries.append(cleaned)
                        await _emit(doc_id, {
                            "phase": "entry", "index": len(entries) - 1, "entry": cleaned,
                        })

                # Periodic heartbeat
                now = asyncio.get_event_loop().time()
                if now - last_heartbeat > 5:
                    last_heartbeat = now
                    await _emit(doc_id, {"phase": "heartbeat", "entries": len(entries)})

    if not entries:
        # Fallback: try strict parse on the full payload (some responses arrive whole)
        full = "".join(accumulated)
        entries = _coerce_json_array(full) if full.strip() else []
    return entries


async def _stream_gemini(doc_id: str, target: dict, text: str) -> list[dict]:
    import google.generativeai as genai
    genai.configure(api_key=target["api_key"])
    model = genai.GenerativeModel(
        target.get("model") or "gemini-2.0-flash",
        system_instruction=SYSTEM_PROMPT,
    )
    streamer = JsonObjectStreamer()
    accumulated: list[str] = []
    entries: list[dict] = []
    last_heartbeat = asyncio.get_event_loop().time()

    response = await model.generate_content_async(
        text[:200000],
        generation_config={"response_mime_type": "application/json", "temperature": 0.2},
        stream=True,
    )
    async for chunk in response:
        piece = getattr(chunk, "text", "") or ""
        if not piece:
            continue
        accumulated.append(piece)
        await _emit(doc_id, {"phase": "chunk", "text": piece[-UI_CHUNK_TAIL_CHARS:]})
        for raw_obj in streamer.feed(piece):
            cleaned = _coerce_one(raw_obj)
            if cleaned:
                entries.append(cleaned)
                await _emit(doc_id, {
                    "phase": "entry", "index": len(entries) - 1, "entry": cleaned,
                })
        now = asyncio.get_event_loop().time()
        if now - last_heartbeat > 5:
            last_heartbeat = now
            await _emit(doc_id, {"phase": "heartbeat", "entries": len(entries)})

    if not entries:
        full = "".join(accumulated)
        entries = _coerce_json_array(full) if full.strip() else []
    return entries


# ── Entry coercion ─────────────────────────────────────────────────────────


def _coerce_one(raw_obj: str) -> dict | None:
    try:
        item = json.loads(raw_obj)
    except json.JSONDecodeError:
        return None
    if not isinstance(item, dict) or not item.get("content"):
        return None
    return {
        "name": (item.get("name") or "Untitled")[:50],
        "content": str(item["content"]),
        "category": item.get("category") or "imported",
        "task_type": item.get("task_type"),
        "tags": item.get("tags") if isinstance(item.get("tags"), list) else None,
        "negative_prompt": item.get("negative_prompt") or None,
    }


def _coerce_json_array(payload: str) -> list[dict]:
    payload = (payload or "").strip()
    if payload.startswith("```"):
        payload = payload.split("```")[1]
        if payload.startswith("json"):
            payload = payload[4:]
        payload = payload.rsplit("```", 1)[0]
        payload = payload.strip()
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        try:
            data = json.loads(payload[payload.index("[") : payload.rindex("]") + 1])
        except Exception as e:
            raise ValueError(f"LLM response was not valid JSON: {e}\nPayload: {payload[:500]}")
    if isinstance(data, dict):
        for key in ("prompts", "items", "data"):
            if key in data and isinstance(data[key], list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError(f"Expected JSON array, got {type(data).__name__}")
    cleaned: list[dict] = []
    for item in data:
        c = _coerce_one(json.dumps(item, ensure_ascii=False))
        if c:
            cleaned.append(c)
    return cleaned


# ── Engine entrypoint ──────────────────────────────────────────────────────


async def run_parse_prompt(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    doc_id = params.get("doc_id")
    if not doc_id:
        raise ValueError("doc_id is required")

    # Open the queue so the SSE endpoint can subscribe before we emit.
    get_progress_queue(doc_id)

    async with async_session() as db:
        doc = await db.get(PromptDoc, doc_id)
        if not doc:
            raise ValueError(f"PromptDoc {doc_id} not found")
        await db.execute(
            update(PromptDoc)
            .where(PromptDoc.id == doc_id)
            .values(parse_status="parsing", parse_error=None)
        )
        await db.commit()
        path = Path(doc.file_path)
        fmt = doc.format

    await progress_cb(total=1, processed=0)
    await _emit(doc_id, {"phase": "started", "format": fmt, "filename": path.name})

    try:
        await _emit(doc_id, {"phase": "extracting", "format": fmt})
        raw = await _extract_text(path, fmt, doc_id)
        if not raw.strip():
            raise ValueError("Document is empty")
        await _emit(doc_id, {"phase": "extracted", "chars": len(raw)})

        entries = await _call_llm_streaming(doc_id, raw)

        async with async_session() as db:
            await db.execute(
                update(PromptDoc)
                .where(PromptDoc.id == doc_id)
                .values(
                    parse_status="success",
                    parsed_count=len(entries),
                    raw_content=raw[:50000],
                    parsed_payload=entries,
                    parse_error=None,
                    updated_at=datetime.utcnow(),
                )
            )
            await db.commit()

        await progress_cb(processed=1, total=1)
        await _emit(doc_id, {"phase": "complete", "count": len(entries), "entries": entries})
        logger.info("Parsed %d prompts from %s", len(entries), path.name)
    except Exception as e:
        logger.exception("Prompt parsing failed for %s", doc_id)
        async with async_session() as db:
            await db.execute(
                update(PromptDoc)
                .where(PromptDoc.id == doc_id)
                .values(
                    parse_status="failed",
                    parse_error=str(e)[:1000],
                    updated_at=datetime.utcnow(),
                )
            )
            await db.commit()
        await _emit(doc_id, {"phase": "failed", "error": str(e)[:500]})
        raise
    finally:
        # Drop the queue after a short grace period so a slow consumer can
        # still read the final 'complete' event before we GC.
        async def _gc():
            await asyncio.sleep(15)
            _progress_queues.pop(doc_id, None)
        asyncio.create_task(_gc())
