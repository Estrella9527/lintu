"""SVG 矢量生成 —— 走 ChatGPT 类大模型,按提示词直接产出 SVG 代码(6.11 需求)。

默认能力:把图的提示词(没有提示词的原片则附图让模型看图)交给 chat 模型,
要求输出一份完整、自包含的 `<svg>`。与 vtracer 位图描摹(trace 模式)互补:
AI 模式得到的是"重新创作的矢量插画",线条/色块干净、可编辑性强。

Provider 选择:设置 `svg_provider`(默认 relay:gpt5.5);取不到时报结构化错误。
"""
from __future__ import annotations

import logging
import re

import httpx

from sidecar.defaults import get_setting
from sidecar.providers import registry
from sidecar.providers.openai_compat import _build_url, _encode_image_for_analysis

logger = logging.getLogger(__name__)

_SVG_RE = re.compile(r"<svg\b[^>]*>.*?</svg>", re.DOTALL | re.IGNORECASE)

_SYSTEM = (
    "You are a professional vector illustrator. Output ONE complete, "
    "self-contained SVG document and NOTHING else (no markdown fences, no "
    "explanations). Requirements: include xmlns and a viewBox; use only "
    "vector primitives (path/rect/circle/polygon/text/gradients); never "
    "embed raster images or external references; keep shapes clean and "
    "editable; respect the aspect ratio you are given."
)


class SvgAiError(RuntimeError):
    pass


async def generate_svg_via_llm(
    *,
    prompt: str | None,
    image_path: str | None,
    aspect: tuple[int, int] | None = None,
) -> str:
    """生成 SVG 文本。prompt 优先(生成图自带提示词);原片无提示词则附图看图重绘。"""
    provider_name = (get_setting("svg_provider") or "").strip() or "relay:gpt5.5"
    try:
        provider = registry.get_provider(provider_name)
    except Exception as e:
        raise SvgAiError(
            f"SVG 生成模型不可用({provider_name}):{e}。"
            "到 设置 → AI 服务商 配置一个 ChatGPT 类供应商,或在 config 设 svg_provider。"
        )

    ratio_hint = f" Target aspect ratio: {aspect[0]}:{aspect[1]}." if aspect else ""
    content: list[dict] = []
    if prompt and prompt.strip():
        content.append({
            "type": "text",
            "text": (
                "Create a vector illustration as SVG for the following description"
                f"(Chinese is fine).{ratio_hint}\n\nDescription: {prompt.strip()[:1500]}"
            ),
        })
        # 有图也一并附上作风格参考(可选)
        if image_path:
            try:
                b64 = _encode_image_for_analysis(image_path, max_size=768)
                content.append({"type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
            except Exception:
                pass
    elif image_path:
        b64 = _encode_image_for_analysis(image_path, max_size=1024)
        content.append({
            "type": "text",
            "text": ("Redraw this photo as a clean, flat vector illustration in SVG."
                     f"{ratio_hint} Capture the key subjects, composition and palette."),
        })
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
    else:
        raise SvgAiError("没有可用的提示词或图片")

    url = _build_url(provider.base_url, "/chat/completions")
    headers = {"Authorization": f"Bearer {provider.api_key}", "Content-Type": "application/json"}
    body = {
        "model": provider.model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": content},
        ],
        "max_tokens": 16000,
        "temperature": 0.4,
    }
    timeout = httpx.Timeout(connect=15, read=300, write=60, pool=30)
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            raise SvgAiError(f"SVG 模型调用失败 {resp.status_code}: {(resp.text or '')[:200]}")
        data = resp.json()

    raw = ""
    try:
        c = data["choices"][0]["message"]["content"]
        raw = c if isinstance(c, str) else "".join(
            b.get("text", "") for b in c if isinstance(b, dict))
    except Exception:
        raise SvgAiError(f"SVG 模型返回结构异常: {str(data)[:200]}")

    m = _SVG_RE.search(raw)
    if not m:
        raise SvgAiError("模型没有返回有效的 SVG(可重试,或改用位图描摹模式 mode=trace)")
    svg = m.group(0)
    if "xmlns" not in svg:
        svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    return svg
