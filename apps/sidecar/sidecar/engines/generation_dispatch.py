"""Single entry point for canvas-driven image generation.

Phase 1 design (per v0.3 plan §4 PR-1):
- 9 generation types: text2img, img2img, outpaint, inpaint, matting, eraser,
  upscale, text-zh, edit (Ask AI).
- **All types route to the same image2 provider** (whatever the user picked
  in 设置 → AI 服务商 default_image_provider). The dispatch layer differs
  only in:
    * which provider method to call (`generate_text2img` vs `generate_image`)
    * what prompt prefix to inject (each type carries a system instruction
      so the same underlying model can fake all 7 behaviors)

When Phase 2/Agent comes in we'll replace the "all → one provider" routing
with per-type model selection. For now the contract is stable: caller passes
`type`, dispatcher figures out the rest.

Errors are bubbled up as structured exceptions; the FastAPI layer turns them
into 4xx/5xx JSON {error: {code, message}} so the canvas UI can show a clear
toast instead of an opaque 500.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Literal, Optional

from sidecar.providers import registry
from sidecar.providers.base import (
    ImageProvider,
    PermanentError,
    ProviderError,
    TransientError,
)

logger = logging.getLogger(__name__)


GenerationType = Literal[
    "text2img",   # 文生图 — Prompt 栏发起
    "img2img",   # 图生图 — Prompt 栏拖入参考
    "outpaint",  # 任意尺寸扩图
    "inpaint",   # 局部重绘 (mask required)
    "matting",   # 抠图 / 去背景
    "eraser",    # 智能消除
    "upscale",   # 超分增强
    "text-zh",   # 中文文字
    "edit",      # Ask AI 自然语言改图
]


VALID_TYPES = {
    "text2img", "img2img", "outpaint", "inpaint",
    "matting", "eraser", "upscale", "text-zh", "edit",
}


# Prompt prefixes per type. Phase 1 strategy: same underlying model image2
# pretends to be every operation by being told what to do. These are tuned
# for English-instruction-following image models; tweak after dogfood.
_TYPE_PREFIXES: dict[str, str] = {
    "img2img": "Generate a new variant of this image: {prompt}",
    "outpaint": (
        "Extend (outpaint) the image to fill a {target_w}x{target_h} canvas. "
        "Preserve the original pixels exactly; only fill the newly exposed "
        "surrounding area naturally and seamlessly. {prompt}"
    ),
    "inpaint": (
        "Inpaint the masked region. Keep everything outside the mask "
        "untouched. New content: {prompt}"
    ),
    "matting": (
        "Remove the background and keep only the main subject on a "
        "transparent background. Clean edges, no halo."
    ),
    "eraser": (
        "Erase the unwanted objects ({prompt}) seamlessly. Reconstruct the "
        "background so the removed area looks natural."
    ),
    "upscale": (
        "Upscale this image to 2x resolution. Sharpen details, repair "
        "artifacts, keep the original composition and colors."
    ),
    "text-zh": (
        "Add the following Chinese text as a tasteful overlay on the image: "
        '"{prompt}". Render every character accurately with correct strokes — '
        "no garbled, missing or invented glyphs. Use clean, high-quality "
        "typography; choose a placement, size and color that fits the scene."
    ),
    "edit": (
        # Ask AI — pure NL instruction, no prefix needed beyond the user's words
        "{prompt}"
    ),
}


@dataclass(slots=True)
class GenerationCandidate:
    """One generated image, ready for the canvas to display or persist."""
    image_data: bytes
    seed: int | None
    cost_usd: float


class GenerationFailure(Exception):
    """Wraps provider errors so the router can return structured JSON."""
    def __init__(self, code: str, message: str, status: int = 500):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _build_prompt(gtype: str, user_prompt: str, instruction: str | None,
                  target_w: int | None, target_h: int | None) -> str:
    """Compose the final prompt sent to the provider for a given type.

    For `edit` (Ask AI) we use `instruction` instead of `prompt` because the
    PRD distinguishes them: prompt is for text2img/img2img, instruction is the
    NL change directive.
    """
    if gtype == "edit":
        body = (instruction or "").strip()
        if not body:
            raise GenerationFailure("missing_instruction",
                "Ask AI requires `instruction`", status=400)
        return body
    prefix = _TYPE_PREFIXES.get(gtype, "{prompt}")
    return prefix.format(
        prompt=(user_prompt or "").strip(),
        target_w=target_w or 0,
        target_h=target_h or 0,
    )


def _pick_provider(model_id: str | None) -> ImageProvider:
    """Pick the single image provider.

    前端 PromptBar 的「模型」下拉传过来的 `model_id` 其实是**供应商 id**
    (`gemini` / `relay:<name>`,来自 /api/providers/available 的 `id` 字段),
    不是模型名。早期 bug:这里把它当 image_model 传给 chain,导致供应商 id
    被当成模型名发给默认供应商 → 生成失败 / 走错供应商 / 计费错通道。

    正确语义:
      - model_id 非空 → 按供应商 id 精确选中那个供应商(模型名由该供应商自身
        配置决定);选中失败再回退到默认链头,不让一次选择直接报错。
      - model_id 空 → 用默认链头(default_image_provider)。
    """
    return _pick_provider_chain(model_id)[0]


def _pick_provider_chain(model_id: str | None) -> list[ImageProvider]:
    """返回带降级顺序的供应商链。

    - model_id 指定 → 该供应商置链首,默认链其余供应商跟在后面做兜底
      (用户明确选了 A,但 A 挂了时仍能用 B/C 出图,而不是直接失败)。
    - model_id 空 → 直接用默认链(default_image_provider 在首)。
    """
    chain = registry.get_image_provider_chain()
    if model_id:
        try:
            chosen = registry.get_provider(model_id)
            # 选中的放最前,默认链里去掉同名的,其余作为 fallback
            rest = [p for p in chain if getattr(p, "name", None) != getattr(chosen, "name", None)]
            chain = [chosen, *rest]
        except Exception as e:
            logger.warning("provider %r 不可用,使用默认链: %s", model_id, e)
    if not chain:
        raise GenerationFailure(
            "no_provider",
            "未配置图像生成 Provider。请到 设置 → AI 服务商 配置 default_image_provider。",
            status=400,
        )
    return chain


async def _one_shot_with_fallback(
    gtype: str,
    providers: list[ImageProvider],
    *,
    final_prompt: str,
    input_image_path: Optional[str],
    **kwargs,
) -> GenerationCandidate:
    """按链顺序尝试供应商,直到一个成功;全失败抛最后一个错误。

    单供应商宕机/限流时,客户的生产线不至于一次失败就全灭。
    """
    last_exc: BaseException | None = None
    for i, provider in enumerate(providers):
        try:
            return await _one_shot(
                gtype, provider,
                final_prompt=final_prompt,
                input_image_path=input_image_path,
                **kwargs,
            )
        except GenerationFailure as e:
            # 参数类错误(400)换供应商也没用,直接抛;供应商侧错误才降级
            if e.status and 400 <= e.status < 500:
                raise
            last_exc = e
            logger.warning("provider %s 失败,尝试下一个(%d/%d): %s",
                           getattr(provider, "name", "?"), i + 1, len(providers), e)
        except Exception as e:
            last_exc = e
            logger.warning("provider %s 异常,尝试下一个(%d/%d): %s",
                           getattr(provider, "name", "?"), i + 1, len(providers), e)
    if isinstance(last_exc, BaseException):
        raise last_exc
    raise GenerationFailure("no_provider", "无可用供应商", status=502)


async def _one_shot(
    gtype: str,
    provider: ImageProvider,
    *,
    final_prompt: str,
    input_image_path: Optional[str],
    **kwargs,
) -> GenerationCandidate:
    """Single round-trip to the provider, regardless of type.

    text2img → `generate_text2img(prompt)`
    everything else → `generate_image(image_path, prompt)`(image required)
    """
    try:
        if gtype == "text2img":
            if not hasattr(provider, "generate_text2img"):
                raise GenerationFailure(
                    "provider_no_text2img",
                    f"Provider {provider.name} 不支持 text2img(Phase 1 需要 OpenAICompat 类 Provider)",
                    status=400,
                )
            out = await provider.generate_text2img(final_prompt, **kwargs)
        else:
            if not input_image_path:
                raise GenerationFailure(
                    "missing_input_image",
                    f"type={gtype} 需要 input_image_id",
                    status=400,
                )
            out = await provider.generate_image(input_image_path, final_prompt, **kwargs)
    except GenerationFailure:
        raise
    except PermanentError as e:
        raise GenerationFailure("provider_permanent", str(e), status=400)
    except TransientError as e:
        raise GenerationFailure("provider_transient", str(e), status=502)
    except ProviderError as e:
        raise GenerationFailure("provider_error", str(e), status=502)
    except Exception as e:
        logger.exception("provider call crashed for type=%s", gtype)
        raise GenerationFailure("provider_crash", str(e) or "unknown error", status=502)

    return GenerationCandidate(
        image_data=out["image_data"],
        seed=out.get("seed"),
        cost_usd=float(out.get("cost_usd") or 0),
    )


def _compose_outpaint_canvas(
    image_path: str, target_w: int, target_h: int,
    align_x: str, align_y: str,
) -> bytes:
    """把原图按 align 放进 target_w × target_h 的透明 RGBA 画布,转 PNG bytes。

    底模(/v1/images/edits)看到透明区域时会自动 fill — 这就是 outpaint
    的工作原理。我们不需要传 mask:透明本身就是 mask。

    align_x: 'left' | 'center' | 'right'
    align_y: 'top'  | 'middle' | 'bottom'
    """
    from io import BytesIO
    from PIL import Image as PILImage

    src = PILImage.open(image_path).convert("RGBA")
    sw, sh = src.size
    # 目标必须 ≥ 原图,否则没东西可"扩"
    tw = max(target_w, sw)
    th = max(target_h, sh)

    canvas = PILImage.new("RGBA", (tw, th), (0, 0, 0, 0))
    # 计算 offset(原图在 canvas 内的左上角)
    ox = 0 if align_x == "left" else (tw - sw) if align_x == "right" else (tw - sw) // 2
    oy = 0 if align_y == "top"  else (th - sh) if align_y == "bottom" else (th - sh) // 2
    canvas.paste(src, (ox, oy), src)

    buf = BytesIO()
    canvas.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


async def _resolve_style_archive_prefix(style_archive_id: str | None) -> str:
    """读 StyleArchive,把 description 拼到 prompt 前缀。Phase 1 不喂 ref_images
    给底模(等 Phase 2 接 seedream 多图参考时再加)。"""
    if not style_archive_id:
        return ""
    from sidecar.db.models import StyleArchive
    from sidecar.db.session import async_session
    from sqlalchemy import select
    async with async_session() as db:
        sa = (await db.execute(
            select(StyleArchive).where(StyleArchive.id == style_archive_id)
        )).scalar_one_or_none()
    if not sa or not (sa.description or "").strip():
        return ""
    return f"风格参考: {sa.description.strip()}. "


async def dispatch(
    *,
    gtype: str,
    prompt: str | None,
    instruction: str | None,
    input_image_path: Optional[str],
    target_w: int | None,
    target_h: int | None,
    model_id: str | None,
    count: int,
    mask_bytes: bytes | None = None,
    align_x: str | None = None,
    align_y: str | None = None,
    style_archive_id: str | None = None,
    **provider_kwargs,
) -> list[GenerationCandidate]:
    """Generate `count` candidates for the given type.

    count > 1 → call the provider concurrently `count` times(asyncio.gather)。
    并发原因见函数体注释;部分失败时返回成功的候选,全部失败才抛错。
    """
    if gtype not in VALID_TYPES:
        raise GenerationFailure(
            "invalid_type",
            f"type={gtype!r} not in {sorted(VALID_TYPES)}",
            status=400,
        )
    if count < 1 or count > 4:
        raise GenerationFailure(
            "invalid_count",
            "count must be in [1, 4]",
            status=400,
        )

    # v0.3 PR-8:inpaint / eraser 必须带 mask;outpaint 必须给目标 W/H + align
    if gtype in ("inpaint", "eraser") and not mask_bytes:
        raise GenerationFailure(
            "missing_mask",
            f"type={gtype} 需要 mask(base64 PNG,白=改 黑=保)",
            status=400,
        )
    if gtype == "outpaint":
        if not (target_w and target_h):
            raise GenerationFailure(
                "missing_target_size", "outpaint 必须给 target_w / target_h", status=400,
            )
        if not align_x: align_x = "center"
        if not align_y: align_y = "middle"
        if align_x not in {"left", "center", "right"} or align_y not in {"top", "middle", "bottom"}:
            raise GenerationFailure(
                "invalid_align", "align_x ∈ {left,center,right}, align_y ∈ {top,middle,bottom}", status=400,
            )

    final_prompt = _build_prompt(gtype, prompt or "", instruction,
                                 target_w, target_h)
    # 风格档案 description 拼到 prompt 前缀(Phase 1 简化路径)
    style_prefix = await _resolve_style_archive_prefix(style_archive_id)
    if style_prefix:
        final_prompt = style_prefix + final_prompt

    # 「中文文字」按能力路由:用户没手选模型时,默认走文字渲染强的供应商
    # (Seedream 系,即梦同源;6.10 反馈:默认 gpt-image 文字效果差)。
    # _pick_provider_chain 会把它置链首、默认链兜底,挂了自动降级。
    if gtype == "text-zh" and not model_id:
        from sidecar.defaults import get_setting
        model_id = (get_setting("text_render_provider") or "").strip() or None

    providers = _pick_provider_chain(model_id)

    extra: dict = dict(provider_kwargs)
    # text2img / img2img / edit / text-zh 都把用户选的输出比例传给模型 —— 此前
    # 只有 text2img 传,图生图被丢到全局默认 2048x2048,用户选什么比例都出方图
    # (6.10 反馈 P0)。outpaint 走 compose 路径单独算;inpaint/eraser 在下面按原图。
    if gtype in ("text2img", "img2img", "edit", "text-zh") and target_w and target_h:
        extra["size"] = f"{target_w}x{target_h}"
    # inpaint / eraser:默认按被涂抹的原图尺寸出图(前端传原图 W/H),
    # 不再退到模型默认的 2048/1024(用户反馈:局部重绘应保持原图尺寸)。
    if gtype in ("inpaint", "eraser") and target_w and target_h:
        extra["size"] = f"{target_w}x{target_h}"
    if gtype == "outpaint" and input_image_path:
        # 在 dispatch 层把原图 compose 进透明画布,provider 看到的"原图"已经
        # 是目标尺寸 + 透明边的 PNG;模型自动 inpaint 透明区
        try:
            extra["compose_bytes"] = _compose_outpaint_canvas(
                input_image_path, target_w or 0, target_h or 0,
                align_x or "center", align_y or "middle",
            )
            extra["size"] = f"{target_w}x{target_h}"
        except Exception as e:
            raise GenerationFailure("compose_failed", f"原图合成画布失败: {e}", status=500)
    # inpaint / eraser 直接把 mask bytes 转发给 provider
    if mask_bytes is not None:
        extra["mask_bytes"] = mask_bytes

    # count > 1 时并行调 provider — 串行会让总时长 ×count(单张图生图 1-3 分钟,
    # 3 张候选串行 = 前端转圈 3-9 分钟,用户以为挂了;后台第一张完成时 token 已计费,
    # 与前端"还在生成中"形成割裂感)。并行后总时长 ≈ 单张时长。
    # return_exceptions=True:部分失败不全军覆没 — 已花钱生成出来的候选照常返回,
    # 全部失败才抛错。
    results = await asyncio.gather(
        *(
            _one_shot_with_fallback(
                gtype, providers,
                final_prompt=final_prompt,
                input_image_path=input_image_path,
                **extra,
            )
            for _ in range(count)
        ),
        return_exceptions=True,
    )
    candidates = [r for r in results if isinstance(r, GenerationCandidate)]
    failures = [r for r in results if isinstance(r, BaseException)]
    for f in failures:
        logger.warning("generate candidate failed (%d/%d ok): %s", len(candidates), count, f)
    if not candidates:
        first = failures[0]
        if isinstance(first, GenerationFailure):
            raise first
        raise GenerationFailure("provider_error", f"全部候选生成失败: {first}", status=502)
    return candidates
