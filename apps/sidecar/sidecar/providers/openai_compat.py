"""OpenAI-compatible provider for vision tagging AND image generation."""

import base64
import io
import json
import logging
import re
from pathlib import Path

import httpx
from PIL import Image as PILImage

from sidecar.defaults import get_setting
from sidecar.providers.base import ImageProvider, PermanentError

logger = logging.getLogger(__name__)


# Byte signature → (extension, mime)
_BYTE_SIGS = (
    (b"\x89PNG\r\n\x1a\n", "png",  "image/png"),
    (b"\xff\xd8\xff",       "jpg",  "image/jpeg"),
    (b"GIF87a",             "gif",  "image/gif"),
    (b"GIF89a",             "gif",  "image/gif"),
    (b"BM",                 "bmp",  "image/bmp"),
)


def _sniff_bytes(data: bytes) -> tuple[str, str]:
    """Return (ext, mime) inferred from bytes; defaults to ('bin','application/octet-stream')."""
    if not data:
        return "bin", "application/octet-stream"
    head = data[:16]
    for sig, ext, mime in _BYTE_SIGS:
        if head.startswith(sig):
            return ext, mime
    # WebP: "RIFF....WEBP"
    if head.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    return "bin", "application/octet-stream"


def _mime_for_ext(ext: str) -> str:
    e = ext.lower().lstrip(".")
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "gif": "image/gif",
        "webp": "image/webp", "bmp": "image/bmp",
        "tif": "image/tiff", "tiff": "image/tiff",
        "heic": "image/heic", "heif": "image/heif",
    }.get(e, "application/octet-stream")


def _read_original_bytes(image_path: str) -> tuple[bytes, str, str]:
    """Return (bytes, ext_without_dot, mime) for the file at image_path.

    Zero decoding, zero re-encoding. This is the canonical reader for sending
    an image to any provider API.

    Enforces `upload_max_bytes` + `upload_oversize_policy`:
      - fail   → raise PermanentError so the subtask surfaces; user fixes source
      - shrink → downscale via PIL to fit (warned, lossy path)
    """
    with open(image_path, "rb") as f:
        data = f.read()
    sniff_ext, sniff_mime = _sniff_bytes(data)
    path_ext = Path(image_path).suffix.lower().lstrip(".")
    # Prefer byte signature; fall back to filename extension if unknown.
    ext = sniff_ext if sniff_ext != "bin" else (path_ext or "bin")
    mime = sniff_mime if sniff_mime != "application/octet-stream" else _mime_for_ext(ext)

    max_bytes = int(get_setting("upload_max_bytes") or 0)
    if max_bytes > 0 and len(data) > max_bytes:
        policy = (get_setting("upload_oversize_policy") or "fail").lower()
        if policy == "shrink":
            logger.warning(
                "Image %s is %.1fMB > %.1fMB limit — shrinking (LOSSY)",
                image_path, len(data) / 1e6, max_bytes / 1e6,
            )
            data, ext, mime = _shrink_bytes(data, max_bytes, src_ext=ext)
        else:
            raise PermanentError(
                f"image too large: {len(data)//1024} KB > {max_bytes//1024} KB limit "
                f"(adjust settings.upload_max_bytes or enable 'shrink' policy)"
            )
    return data, ext, mime


def _shrink_bytes(data: bytes, max_bytes: int, *, src_ext: str) -> tuple[bytes, str, str]:
    """Progressively downscale an in-memory image until it fits under max_bytes.

    Preserves format when the format itself is lossless-capable; for JPEG we
    use quality=95 (still close to perceptually lossless at typical viewing
    distances; used ONLY when the user opted into 'shrink' policy).
    """
    img = PILImage.open(io.BytesIO(data))
    fmt = (img.format or src_ext.upper()).upper()
    if img.mode in ("P", "LA"):
        img = img.convert("RGBA" if img.mode == "LA" else "RGB")
    # Halve dimensions until we fit. Cap iterations at 6 (so 1/64 of original).
    for _ in range(6):
        buf = io.BytesIO()
        if fmt == "PNG":
            img.save(buf, "PNG", compress_level=6)
            out_ext, out_mime = "png", "image/png"
        elif fmt == "WEBP":
            img.save(buf, "WEBP", lossless=True)
            out_ext, out_mime = "webp", "image/webp"
        else:
            save_img = img.convert("RGB") if img.mode == "RGBA" else img
            save_img.save(buf, "JPEG", quality=95, subsampling=0, optimize=True)
            out_ext, out_mime = "jpg", "image/jpeg"
        out = buf.getvalue()
        if len(out) <= max_bytes:
            return out, out_ext, out_mime
        img = img.resize((max(1, img.width // 2), max(1, img.height // 2)), PILImage.LANCZOS)
    # Still too big — return last attempt and let the provider decide
    return out, out_ext, out_mime


def _encode_image_data_url(image_path: str) -> tuple[str, str]:
    """Return (data_url, mime) for embedding in chat/multimodal JSON payloads.

    Preserves the original bytes. Base64 encoding is NOT a pixel transform —
    it's just a transport wrapper required by the data URL spec.
    """
    data, _ext, mime = _read_original_bytes(image_path)
    b64 = base64.b64encode(data).decode()
    return f"data:{mime};base64,{b64}", mime


def _encode_image_for_analysis(image_path: str, max_size: int = 2048) -> str:
    """Downsampled JPEG for ANALYSIS-ONLY calls (tagging / embedding / orient
    AI classifier). The output of these calls is TEXT (tags / vectors / a
    single word decision) — the image bytes never flow back to the user, so
    downscaling here does NOT violate the 'zero re-encoding' promise that
    applies to the generation pipeline.
    """
    img = PILImage.open(image_path)
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")
    img.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


_VERSION_SEGMENT = re.compile(r"/v\d+(?:/|$)")


def _build_url(base_url: str, path: str) -> str:
    base = base_url.rstrip("/")
    # Skip auto /v1 prefix when caller already supplies a versioned path
    # (e.g. Volcengine Ark's /api/v3, or any /v2, /v3 base).
    if _VERSION_SEGMENT.search(base):
        return base + path
    return base + "/v1" + path


# Models that use the OpenAI Images API (multipart/form-data on /v1/images/edits).
# Chat-completions path won't return useful images for these — skip straight to
# the correct endpoint.
_IMAGES_API_MODEL_PATTERNS = (
    "gpt-image",     # gpt-image-1, gpt-image-2, gpt-image-2-all, …
    "dall-e",        # DALL-E 2 / 3
    "imagen",
    "flux",
    "seedream",      # Volcengine Ark doubao-seedream-3/4/4.5/5 (text+image2image)
)


def _is_images_api_model(model: str) -> bool:
    m = (model or "").lower()
    return any(p in m for p in _IMAGES_API_MODEL_PATTERNS)


def _is_seedream(model: str) -> bool:
    """Volcengine Ark Seedream — uses /v1/images/generations with JSON
    (NOT multipart). Accepts both text-to-image (no `image`) and
    image-to-image (`image` field with one or many URLs / data URIs).
    """
    return "seedream" in (model or "").lower()


def _normalize_seedream_size(value: str) -> str:
    """Map common output-size strings to Seedream-accepted forms.

    Seedream accepts {"1K","2K","4K"} or "WxH" (W,H ∈ [512, 4096]).
    A user-set "2048x2048" passes through; "2048" or "2K" stays as-is.
    """
    if not value:
        return ""
    v = value.strip().upper()
    if v in {"1K", "2K", "4K"}:
        return v
    # Accept "1024x1024" / "2048x2048" / "4096x4096"
    if "x" in v.lower():
        return v.lower()
    return ""


class OpenAICompatProvider(ImageProvider):
    def __init__(self, base_url: str, api_key: str, model: str = "gpt-4o"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    # ── Vision / Tagging ──

    async def tag_image(self, image_path: str, prompt: str | None = None) -> dict:
        # Analysis-only call (returns text tags) — downscale OK, doesn't
        # affect user-visible image quality.
        b64 = _encode_image_for_analysis(image_path)
        url = _build_url(self.base_url, "/chat/completions")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, headers=self._headers, json={
                "model": self.model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": prompt or "Describe this image."},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ]}],
                "max_tokens": 1000,
            })
            resp.raise_for_status()
            data = resp.json()

        text = data["choices"][0]["message"]["content"]
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        tags = json.loads(text.strip())

        usage = data.get("usage", {})
        cost = usage.get("total_tokens", 500) * 0.000003

        return {"tags": tags, "cost_usd": cost}

    # ── Image Generation (img2img) ──

    # Errors that are auth/quota/policy related — these mean the upstream
    # actively rejected and **already charged**. Don't fall back to the
    # other endpoint: it would just charge a second time for the same root
    # cause. Bubble up immediately so the batch can decide whether to bail.
    _NO_FALLBACK_STATUSES = (401, 402, 403, 429)

    async def generate_image(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Route to the right endpoint based on model family.

        - gpt-image-* / dall-e-* / flux / imagen → /v1/images/edits (multipart)
        - Everything else (chat-multimodal models like gpt-4o, gemini-*-image)
          → /v1/chat/completions

        Fallback to the OTHER endpoint only when the failure looks like
        "endpoint not supported" (404 / 405 / NotImplementedError / ValueError
        from "no image data"). Auth / quota / rate-limit errors abort
        immediately so we don't double-bill for what the relay already
        charged us for.
        """
        if _is_images_api_model(self.model):
            primary = self._generate_via_images_api
            secondary = self._generate_via_chat
            primary_label = "Images API"
        else:
            primary = self._generate_via_chat
            secondary = self._generate_via_images_api
            primary_label = "Chat"

        try:
            return await primary(image_path, prompt, **kwargs)
        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else 0
            if status in self._NO_FALLBACK_STATUSES:
                logger.warning(
                    "%s returned %d — NOT falling back (would double-bill). "
                    "Cause: auth / quota / rate-limit",
                    primary_label, status,
                )
                raise
            logger.info("%s failed with %d, trying alt endpoint", primary_label, status)
        except (NotImplementedError, ValueError) as e:
            # "no image data in response" / endpoint shape mismatch — try the
            # other surface
            logger.info("%s failed (%s), trying alt endpoint", primary_label, e)
        # Fallback path
        return await secondary(image_path, prompt, **kwargs)

    async def _generate_via_chat(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Format B: Chat Completions — model returns image in response."""
        # Generation path — send ORIGINAL bytes (no PIL decode / re-encode).
        data_url, _mime = _encode_image_data_url(image_path)
        url = _build_url(self.base_url, "/chat/completions")

        # Generous read budget — slow img-gen models can take minutes
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=360, write=60, pool=60)) as client:
            resp = await client.post(url, headers=self._headers, json={
                "model": self.model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]}],
                "max_tokens": 4096,
            })
            resp.raise_for_status()
            data = resp.json()

        message = data["choices"][0]["message"]
        content = message.get("content", "")

        # Check if response contains image data
        image_data = None

        # Case 1: content is a list with image blocks (OpenAI GPT-4o style)
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "image_url":
                        img_url = block.get("image_url", {}).get("url", "")
                        if img_url.startswith("data:image"):
                            b64_data = img_url.split(",", 1)[1]
                            image_data = base64.b64decode(b64_data)
                    elif block.get("type") == "image" and "source" in block:
                        image_data = base64.b64decode(block["source"].get("data", ""))

        # Case 2: content is string with embedded base64 image
        if not image_data and isinstance(content, str):
            # Look for base64 image data in markdown
            import re
            img_match = re.search(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', content)
            if img_match:
                image_data = base64.b64decode(img_match.group(1))

        if not image_data:
            raise ValueError("Model response did not contain image data")

        usage = data.get("usage", {})
        cost = usage.get("total_tokens", 1000) * 0.00001

        return {"image_data": image_data, "cost_usd": cost}

    async def _generate_via_images_api(self, image_path: str, prompt: str, **kwargs) -> dict:
        """OpenAI Images API — POST /v1/images/edits with multipart/form-data.

        For Volcengine Ark Seedream we route to /v1/images/generations with
        JSON instead — see `_generate_via_seedream`.

        For OpenAI gpt-image-* / DALL-E *: image must be sent as a binary
        file (PNG/JPEG), not JSON-base64. `response_format` is not accepted
        by gpt-image-*; those return b64_json inline.
        """
        if _is_seedream(self.model):
            return await self._generate_via_seedream(image_path, prompt, **kwargs)

        # Generation path — send ORIGINAL bytes. No PIL decode / re-encode.
        img_bytes, ext, mime = _read_original_bytes(image_path)
        url = _build_url(self.base_url, "/images/edits")
        # gpt-image-2 reverse-engineered proxies regularly take 60-300s to
        # return one image. We give a generous 360s read budget so a healthy
        # but slow upstream isn't aborted prematurely.
        timeout = httpx.Timeout(connect=15, read=360, write=60, pool=60)

        # Output size: caller > config > model-default. We default gpt-image
        # to 2048x2048 instead of "auto" so output isn't pinned to whatever
        # tiny version of the seed the upstream proxy may pass through.
        config_size = (get_setting("image_output_size") or "").strip()
        size = (
            kwargs.get("size")
            or config_size
            or ("2048x2048" if _is_images_api_model(self.model) else "1024x1024")
        )
        files = {
            "image": (f"seed.{ext}", img_bytes, mime),
        }
        form = {
            "model": self.model,
            "prompt": prompt,
            "n": "1",
            "size": size,
        }
        # Only add response_format for non-gpt-image (e.g., DALL-E 2) — it's
        # rejected by gpt-image-*.
        if not _is_images_api_model(self.model) or "dall-e" in self.model.lower():
            form["response_format"] = "b64_json"

        # Headers without Content-Type — httpx sets multipart boundary automatically
        headers = {"Authorization": f"Bearer {self.api_key}"}

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=headers, files=files, data=form)
            if resp.status_code >= 400:
                # Surface the body so we can diagnose the relay's actual error
                body_preview = (resp.text or "")[:500]
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} on /v1/images/edits: {body_preview}",
                    request=resp.request, response=resp,
                )
            data = resp.json()

        entry = (data.get("data") or [{}])[0]
        b64_result = entry.get("b64_json", "")
        if b64_result:
            image_data = base64.b64decode(b64_result)
        else:
            url_result = entry.get("url", "")
            if not url_result:
                raise ValueError(f"No image data in response: {str(data)[:300]}")
            async with httpx.AsyncClient(timeout=60) as client:
                img_resp = await client.get(url_result)
                img_resp.raise_for_status()
                image_data = img_resp.content

        # Cost from usage if the relay reports it; else a rough default
        usage = data.get("usage") or {}
        input_tok = int(usage.get("input_tokens", 0))
        output_tok = int(usage.get("output_tokens", 0))
        if input_tok or output_tok:
            # gpt-image-1 official pricing rough: ~$0.00000x per token
            cost = (input_tok + output_tok) * 0.00001
        else:
            cost = 0.02
        return {"image_data": image_data, "cost_usd": cost}


    # ── Image embedding (Phase 2 — Volcengine Ark multimodal) ──

    async def embed_image(
        self,
        image_path: str,
        *,
        max_size: int = 768,
        dimensions: int = 2048,
    ) -> "list[float]":
        """Embed a single image into a unit-normalized vector.

        Routes to the correct endpoint based on model name:

          - Ark `doubao-embedding-vision-*`  →  /v1/embeddings/multimodal
            Body schema:
              { "model", "input": [{"type":"image_url","image_url":{"url":...}}],
                "dimensions": 1024|2048 (default 2048),
                "encoding_format": "float" }
            Response is a SINGLE `data` object (not a list).

          - Generic OpenAI-compat (text embedding only — won't accept image)
            falls back to /v1/embeddings.

        Caller is expected to configure `model` to a vision-embedding model.
        """
        # Analysis-only call (returns a vector) — downscale is acceptable.
        b64 = _encode_image_for_analysis(image_path, max_size=max_size)
        is_ark_vision = "embedding-vision" in (self.model or "").lower()

        if is_ark_vision:
            url = _build_url(self.base_url, "/embeddings/multimodal")
            body = {
                "model": self.model,
                "encoding_format": "float",
                "dimensions": dimensions,
                "input": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }
        else:
            url = _build_url(self.base_url, "/embeddings")
            body = {
                "model": self.model,
                "input": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }

        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=60, write=30, pool=30)) as client:
            resp = await client.post(url, headers=self._headers, json=body)
            if resp.status_code >= 400:
                preview = (resp.text or "")[:500]
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} on {url}: {preview}",
                    request=resp.request, response=resp,
                )
            data = resp.json()

        # Ark multimodal: { "data": { "embedding": [...] }, ... }
        # OpenAI-style:    { "data": [ { "embedding": [...] } ], ... }
        node = data.get("data")
        if isinstance(node, dict):
            vec = node.get("embedding")
        elif isinstance(node, list) and node:
            vec = node[0].get("embedding")
        else:
            vec = None
        if not isinstance(vec, list) or not vec:
            raise ValueError(f"Bad embeddings response: {str(data)[:300]}")
        return vec


    # ── Text embedding (cross-modal, same space as embed_image) ──

    async def embed_text(
        self,
        text: str,
        *,
        dimensions: int = 2048,
    ) -> "list[float]":
        """Embed a piece of text into the SAME vector space as embed_image.

        For Ark `doubao-embedding-vision-*`: the multimodal endpoint accepts
        `{"type": "text", "text": "..."}` items in `input` and returns a
        vector that lives in the same space as image embeddings — this is
        exactly the cross-modal property we need for text→image search.

        For generic OpenAI-compat text embedding (e.g. `text-embedding-3-*`):
        falls back to /v1/embeddings with a flat string input.
        """
        if not text or not text.strip():
            raise ValueError("empty text")
        is_ark_vision = "embedding-vision" in (self.model or "").lower()

        if is_ark_vision:
            url = _build_url(self.base_url, "/embeddings/multimodal")
            body = {
                "model": self.model,
                "encoding_format": "float",
                "dimensions": dimensions,
                "input": [
                    {"type": "text", "text": text},
                ],
            }
        else:
            url = _build_url(self.base_url, "/embeddings")
            body = {"model": self.model, "input": text}

        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=15, read=60, write=30, pool=30)) as client:
            resp = await client.post(url, headers=self._headers, json=body)
            if resp.status_code >= 400:
                preview = (resp.text or "")[:500]
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} on {url}: {preview}",
                    request=resp.request, response=resp,
                )
            data = resp.json()

        node = data.get("data")
        if isinstance(node, dict):
            vec = node.get("embedding")
        elif isinstance(node, list) and node:
            vec = node[0].get("embedding")
        else:
            vec = None
        if not isinstance(vec, list) or not vec:
            raise ValueError(f"Bad text embedding response: {str(data)[:300]}")
        return vec


    # ── Volcengine Ark Seedream (/v1/images/generations JSON, image2image) ──

    async def _generate_via_seedream(self, image_path: str, prompt: str, **kwargs) -> dict:
        """Volcengine Ark Seedream image-to-image.

        Endpoint: POST /api/v3/images/generations  (under our /v1 builder).
        Schema (Ark-specific):
          { "model", "prompt", "image": "data:...", "size": "2K"|"WxH",
            "watermark": false, "response_format": "b64_json" }

        We always set watermark=false (production use) and response_format=b64_json
        so the image comes back inline (Ark's URL response expires in 24h).
        """
        # Generation path — send ORIGINAL bytes.
        data_url, _mime = _encode_image_data_url(image_path)
        url = _build_url(self.base_url, "/images/generations")
        # Output size: caller > global config > 4K (Seedream 4.0+ supports
        # "1K" / "2K" / "4K" or explicit WxH up to 4096x4096).
        config_size = (get_setting("image_output_size") or "").strip()
        size = kwargs.get("size") or _normalize_seedream_size(config_size) or "4K"
        body = {
            "model": self.model,
            "prompt": prompt,
            "image": data_url,
            "size": size,
            "watermark": False,
            "response_format": "b64_json",
        }
        # Seedream is sometimes slow (multi-image fusion can hit 60-90s)
        timeout = httpx.Timeout(connect=15, read=180, write=60, pool=60)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers=self._headers, json=body)
            if resp.status_code >= 400:
                preview = (resp.text or "")[:500]
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} on /v1/images/generations (seedream): {preview}",
                    request=resp.request, response=resp,
                )
            data = resp.json()
        items = data.get("data") or []
        if not items:
            raise ValueError(f"Seedream returned no image data: {str(data)[:300]}")
        entry = items[0]
        b64_result = entry.get("b64_json", "")
        if b64_result:
            image_data = base64.b64decode(b64_result)
        else:
            url_result = entry.get("url", "")
            if not url_result:
                raise ValueError(f"Seedream entry missing both b64_json and url: {str(entry)[:300]}")
            async with httpx.AsyncClient(timeout=60) as client2:
                img_resp = await client2.get(url_result)
                img_resp.raise_for_status()
                image_data = img_resp.content
        # Cost: Ark bills generated_images count × output_tokens ≈ pixels/256
        usage = data.get("usage") or {}
        gen = int(usage.get("generated_images", 1))
        out_tok = int(usage.get("output_tokens", 0))
        # Rough: $0.03 per image baseline
        cost = max(0.03 * gen, out_tok * 0.000004)
        return {"image_data": image_data, "cost_usd": cost}
