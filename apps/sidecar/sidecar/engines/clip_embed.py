"""CLIP / API semantic embedding engine — task_type='embed'.

Produces an image embedding for every image that doesn't yet have one.
Stored as base64(float16 bytes) in `Image.embedding`, tagged with
`Image.embedding_model` so we can migrate later.

Two backends:
  - "clip-local"  → open_clip_torch ViT-B-32 (default; free, ~5-10 min for
                    7k images on Apple Silicon MPS, 512-dim)
  - "api:<relay>" → POST /v1/embeddings on a configured relay
                    (Volcengine Ark `doubao-embedding-vision-*` produces
                    1024-dim vectors; OpenAI `text-embedding-3-large` is
                    text-only and won't accept image inputs)

Backend choice is driven by config key `default_image_embedding_provider`:
  ""           → local CLIP
  "relay:xxx"  → use that relay's /v1/embeddings endpoint

Embeddings power the semantic stage of dedup: two images with cosine
similarity above a threshold are treated as duplicates even when their
perceptual hashes diverge (same attraction, different person posing, etc.).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Sequence

import numpy as np
from sqlalchemy import select, update

from sidecar.db.models import Image, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.engines.image_utils import effective_file_path, register_heif

register_heif()
logger = logging.getLogger(__name__)

MODEL_NAME = "ViT-B-32"
MODEL_PRETRAINED = "laion2b_s34b_b79k"   # public OpenCLIP weight; smaller than OpenAI's
EMBEDDING_TAG_LOCAL = "clip-ViT-B-32-f16"
EMBEDDING_TAG = EMBEDDING_TAG_LOCAL      # legacy alias used by dedup
BATCH_SIZE = 16
API_CONCURRENCY = 5                      # parallel /v1/embeddings calls


# Lazy-initialised module-level singletons — cheap once loaded.
_model = None
_preprocess = None
_device = None


def _select_device() -> str:
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _ensure_model():
    global _model, _preprocess, _device
    if _model is not None:
        return _model, _preprocess, _device
    import open_clip
    import torch

    _device = _select_device()
    logger.info("Loading CLIP %s (%s) on %s", MODEL_NAME, MODEL_PRETRAINED, _device)
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=MODEL_PRETRAINED, device=_device,
    )
    model.eval()
    _model = model
    _preprocess = preprocess
    return _model, _preprocess, _device


# ── Encoding helpers ──────────────────────────────────────────────────────


def encode_vector_bytes(image_paths: Sequence[str]) -> list[np.ndarray | None]:
    """Batch-encode a list of image paths → list of unit-normalized float16 np arrays.

    None is returned for paths that fail to load.
    """
    from PIL import Image as PILImage
    import torch

    model, preprocess, device = _ensure_model()

    tensors = []
    ok_indices = []
    for i, p in enumerate(image_paths):
        try:
            with PILImage.open(p) as im:
                im = im.convert("RGB")
                tensors.append(preprocess(im))
                ok_indices.append(i)
        except Exception as e:
            logger.warning("CLIP preprocess failed for %s: %s", p, e)

    out: list[np.ndarray | None] = [None] * len(image_paths)
    if not tensors:
        return out

    with torch.inference_mode():
        batch = torch.stack(tensors).to(device)
        feats = model.encode_image(batch)
        feats = feats / feats.norm(dim=-1, keepdim=True).clamp_min(1e-6)
        feats_np = feats.detach().to("cpu").to(torch.float16).numpy()

    for j, src_idx in enumerate(ok_indices):
        out[src_idx] = feats_np[j]
    return out


def serialize_vector(vec: np.ndarray) -> str:
    """Store as base64 for portable SQLite Text column."""
    return base64.b64encode(vec.astype(np.float16).tobytes()).decode("ascii")


def deserialize_vector(s: str | None) -> np.ndarray | None:
    if not s:
        return None
    try:
        raw = base64.b64decode(s)
        return np.frombuffer(raw, dtype=np.float16).astype(np.float32)
    except Exception:
        return None


# ── Engine entrypoint ──────────────────────────────────────────────────────


# ── API embedding path (Volcengine Ark, OpenAI, etc.) ──


def _resolve_api_provider() -> "tuple[object, str] | None":
    """If config selects an API embedding provider, return (provider, model_tag).

    Otherwise return None (caller falls back to local CLIP).
    """
    chosen = (get_setting("default_image_embedding_provider") or "").strip()
    if not chosen:
        return None
    try:
        from sidecar.providers.registry import get_provider
        model_override = (get_setting("image_embedding_model_override") or "").strip() or None
        provider = get_provider(chosen, image_model=model_override)
        tag = f"api:{provider.name}:{getattr(provider, 'model', '')}"
        return provider, tag
    except Exception as e:
        logger.warning("API embedding provider %r unavailable, fallback to local CLIP: %s", chosen, e)
        return None


async def _embed_via_api(provider, paths: Sequence[str]) -> list[np.ndarray | None]:
    """Run /v1/embeddings concurrently with bounded parallelism."""
    sem = asyncio.Semaphore(API_CONCURRENCY)

    async def one(p: str) -> np.ndarray | None:
        async with sem:
            try:
                vec = await provider.embed_image(p)
            except Exception as e:
                logger.warning("API embed failed for %s: %s", p, e)
                return None
            arr = np.asarray(vec, dtype=np.float32)
            n = float(np.linalg.norm(arr))
            if n > 0:
                arr = arr / n
            return arr.astype(np.float16)

    return await asyncio.gather(*[one(p) for p in paths])


async def run_embed(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    image_ids = params.get("image_ids") or []
    force = bool(params.get("force"))

    # Decide backend up front so we use the same tag throughout the run
    api_choice = _resolve_api_provider()
    if api_choice is not None:
        provider, embedding_tag = api_choice
        logger.info("CLIP embed: using API path via %s", provider.name)
    else:
        provider = None
        embedding_tag = EMBEDDING_TAG_LOCAL
        logger.info("CLIP embed: using local CLIP (%s)", MODEL_NAME)

    async with async_session() as db:
        if image_ids:
            rows = await db.execute(select(Image).where(Image.id.in_(image_ids)))
        else:
            q = select(Image).where(Image.project_id == task.project_id)
            if not force:
                q = q.where(
                    (Image.embedding.is_(None))
                    | (Image.embedding == "")
                    | (Image.embedding_model != embedding_tag)
                )
            rows = await db.execute(q)
        images = rows.scalars().all()
        total = len(images)

    if total == 0:
        await progress_cb(total=0, processed=0, phase="done")
        return

    if provider is None:
        _ensure_model()  # cold-load local CLIP before progress starts

    await progress_cb(total=total, processed=0, phase="embedding")
    done = 0
    failed = 0

    for i in range(0, total, BATCH_SIZE):
        chunk = images[i:i + BATCH_SIZE]
        paths = [effective_file_path(img) for img in chunk]
        if provider is not None:
            vectors = await _embed_via_api(provider, paths)
        else:
            vectors = encode_vector_bytes(paths)

        async with async_session() as db:
            for img, vec in zip(chunk, vectors):
                if vec is None:
                    failed += 1
                    continue
                encoded = serialize_vector(vec)
                await db.execute(
                    update(Image)
                    .where(Image.id == img.id)
                    .values(embedding=encoded, embedding_model=embedding_tag)
                )
                done += 1
            await db.commit()

        await progress_cb(
            total=total, processed=min(i + BATCH_SIZE, total),
            phase="embedding", ok=done, failed=failed,
        )

    await progress_cb(total=total, processed=total, phase="done", ok=done, failed=failed)
    logger.info("Image embed done: %d/%d embedded, %d failed (tag=%s)", done, total, failed, embedding_tag)
