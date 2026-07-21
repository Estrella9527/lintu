"""AI tagging engine with retry, fallback provider, and dynamic prompt from tag schema."""

import asyncio
import json
import logging
from datetime import datetime

import httpx
from sqlalchemy import delete as sa_delete, select, update

from sidecar.db.models import Image, Tag, Task
from sidecar.db.session import async_session
from sidecar.defaults import get_setting
from sidecar.engines.image_utils import effective_file_path
from sidecar.providers.base import PermanentError
from sidecar.routers.tag_schema import _read_schema

logger = logging.getLogger(__name__)


def build_text_search_blob(file_name: str | None, description: str | None, tag_values: list[str]) -> str:
    """拼接文搜召回用文本(文件名词干 + 描述 + 标签值)。AI 打标与人工改标共用,
    确保任何改标后 text_search_blob 同步刷新,文搜召回不失真。"""
    from pathlib import Path as _Path
    stem = _Path(file_name or "").stem.replace("_", " ")
    parts: list[str] = []
    if stem:
        parts.append(stem)
    if description and description.strip():
        parts.append(description.strip())
    if tag_values:
        parts.append(", ".join(tag_values))
    return "\n".join(parts)


def _build_prompt_from_schema() -> str:  # noqa: C901
    """Build the tagger prompt dynamically from the current schema.

    The prompt asks the vision model to:
      1. Pick from each dimension's allowed values (objective categories)
      2. Write a long structured description (subjective + scenario)

    The long description is what powers keyword recall when the user query
    contains affective / scene-context words ("温馨亲子时光", "震撼日落") that
    don't map to any tag value directly. Without it, abstract queries miss.
    """
    schema = _read_schema()
    sections = []
    for dim, def_ in schema.items():
        label = def_.get("label", dim)
        values = def_.get("values", [])
        required = def_.get("required", False)
        multi = def_.get("multi", False)
        req_text = "必选1个" if required else "可选"
        multi_text = "可选多个" if multi else req_text
        vals_str = ", ".join(values)
        sections.append(f"### {dim}（{label}，{multi_text}）\n{vals_str}")

    dims = "\n\n".join(sections)

    # Output skeleton — schema-driven so adding new dimensions just works.
    output_lines = []
    for dim, d in schema.items():
        if d.get("multi"):
            output_lines.append(f'  "{dim}": ["选1-3个最贴切的"],')
        else:
            output_lines.append(f'  "{dim}": "选1个",')
    output_skel = "\n".join(output_lines)

    return f"""你是一个景区图片视觉分析专家。请分析这张图片，输出严格 JSON。

## 任务

1. **分类标签**：从下方每个维度的预定义值中选择，不可自创。
2. **结构化描述**（description 字段）：用 50-80 字的中文，按以下三段写：
   - **画面**：客观描述图中能看到什么（人/物/场景/动作）
   - **氛围**：主观感受（光线/情绪/色调，让人想到什么场景）
   - **适用**：这张图适合什么用途（亲子/打卡/团建/海报背景等）
   描述要自然口语化，**多用形容词和场景词**（如「温馨」「治愈」「壮阔」「梦幻」「亲子时光」「闺蜜出游」），
   方便后续按文本搜索时匹配到。**避免**只罗列标签里有的词。

## 标签维度

{dims}

## 输出格式

```json
{{
{output_skel}
  "description": "画面：…… 氛围：…… 适合：……"
}}
```

只输出 JSON，不要其他文字。标签必须严格使用预定义值。"""


def _normalize_provider_name(provider_name: str | None) -> str:
    name = (provider_name or "").strip()
    return name[len("relay:"):] if name.startswith("relay:") else name


def _read_relays(config: dict) -> list[dict]:
    relays_raw = config.get("custom_relays", "[]")
    try:
        relays = json.loads(relays_raw) if isinstance(relays_raw, str) else relays_raw
    except (json.JSONDecodeError, TypeError):
        return []
    return relays if isinstance(relays, list) else []


_NON_TAGGING_MODEL_HINTS = (
    "embedding",
    "seedream",
    "gpt-image",
    "dall-e",
    "imagen",
    "flux",
)


def _relay_supports_tagging(relay: dict) -> bool:
    """Best-effort capability gate for automatic tagger fallbacks.

    Explicitly selected providers are still attempted. This filter only keeps
    generation-only and embedding relays out of the automatic fallback list.
    """
    if not relay.get("name") or not relay.get("base_url") or not relay.get("api_key"):
        return False
    model = str(relay.get("model") or "").lower()
    return not any(hint in model for hint in _NON_TAGGING_MODEL_HINTS)


def _provider_candidate_names(primary_name: str, fallback_name: str = "") -> list[str]:
    """Return an ordered, de-duplicated vision-provider fallback chain."""
    from sidecar.routers.config_api import _read_config
    config = _read_config()
    relays = _read_relays(config)

    names: list[str] = []

    def add(value: str | None) -> None:
        name = _normalize_provider_name(value)
        if name and name not in names:
            names.append(name)

    add(primary_name)
    add(fallback_name)
    for relay in relays:
        if _relay_supports_tagging(relay):
            add(relay.get("name"))
    if config.get("gemini_api_key"):
        add("gemini")
    return names


def _get_provider(provider_name: str, *, model_override: str | None = None):
    """Instantiate exactly the named provider.

    Provider fallback is handled explicitly by ``_get_provider_chain``. The
    previous silent "first relay" fallback could route tagging to an image
    generation or embedding model and made configuration failures opaque.
    """
    from sidecar.routers.config_api import _read_config
    config = _read_config()
    provider_name = _normalize_provider_name(provider_name)

    relays = _read_relays(config)

    if provider_name == "gemini":
        api_key = config.get("gemini_api_key", "")
        if api_key:
            from sidecar.providers.gemini import GeminiProvider
            return GeminiProvider(api_key=api_key)
        raise ValueError("Gemini API Key 未配置")

    # Try matching by relay name
    for relay in relays:
        if relay.get("name") == provider_name:
            if not relay.get("base_url") or not relay.get("api_key"):
                raise ValueError(f"AI 服务商 {provider_name} 缺少地址或 API Key")
            from sidecar.providers.openai_compat import OpenAICompatProvider
            return OpenAICompatProvider(
                base_url=relay["base_url"], api_key=relay["api_key"],
                model=model_override or relay.get("model", "gpt-4o"),
            )

    raise ValueError(f"未找到 AI 服务商：{provider_name}")


def _get_provider_chain(primary_name: str, fallback_name: str = "") -> list[tuple[str, object]]:
    """Resolve all usable tagging providers without letting one bad config abort the task."""
    resolved: list[tuple[str, object]] = []
    resolution_errors: list[str] = []
    general_model_override = str(get_setting("general_provider_model") or "").strip()
    for name in _provider_candidate_names(primary_name, fallback_name):
        try:
            if name == _normalize_provider_name(primary_name) and general_model_override:
                provider = _get_provider(name, model_override=general_model_override)
            else:
                provider = _get_provider(name)
            resolved.append((name, provider))
        except Exception as exc:
            resolution_errors.append(f"{name}: {exc}")
            logger.warning("Skipping unavailable tagging provider %s: %s", name, exc)

    if resolved:
        return resolved

    details = "；".join(resolution_errors[:3])
    suffix = f"（{details}）" if details else ""
    raise ValueError(
        "未配置可用于视觉打标的 AI 服务商。"
        "请在设置→AI服务商中配置通用视觉模型。" + suffix
    )


def _response_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        return response.text.strip()[:300]

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])[:300]
        if isinstance(error, str):
            return error[:300]
        for key in ("message", "detail", "error_msg"):
            if payload.get(key):
                return str(payload[key])[:300]
    return str(payload)[:300]


def _format_provider_error(provider_name: str, provider: object, exc: BaseException) -> str:
    model = getattr(provider, "model", None)
    identity = f"服务商 {provider_name}" + (f" / {model}" if model else "")
    if isinstance(exc, httpx.HTTPStatusError):
        message = _response_error_message(exc.response)
        detail = f"：{message}" if message else ""
        return f"{identity} 请求失败（HTTP {exc.response.status_code}）{detail}"
    return f"{identity} 请求失败：{str(exc)[:400]}"


def _should_failover_immediately(exc: BaseException) -> bool:
    """Auth/model/capability errors cannot be repaired by retrying the same provider."""
    if isinstance(exc, PermanentError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return status in {400, 401, 402, 403, 404, 405, 409, 415, 422, 429}
    return False


async def run_tagging(task: Task, progress_cb):
    params = json.loads(task.parameters or "{}")
    concurrency = params.get("concurrency", get_setting("tagger_max_concurrent"))
    cost_limit = params.get("cost_limit", get_setting("tagger_cost_limit_usd"))
    retry_times = max(1, int(get_setting("tagger_retry_times") or 3))
    # Resolution order:
    #   1. explicit `provider` in task params (batch-scoped override)
    #   2. legacy `tagger_provider` config (back-compat)
    #   3. unified `default_general_provider` (the role-assignment UI)
    provider_name = (
        params.get("provider")
        or get_setting("tagger_provider")
        or get_setting("default_general_provider")
        or "gemini"
    )
    provider_name = _normalize_provider_name(provider_name)
    fallback_name = _normalize_provider_name(get_setting("tagger_fallback_provider"))
    # Phase 2: allow batch-triggered runs to scope tagging to a specific set
    # of generated images (skips the global "all pending in project" filter).
    image_ids: list[str] = params.get("image_ids") or []

    schema = _read_schema()
    required_dims = {
        dimension for dimension, definition in schema.items()
        if definition.get("required")
    }
    prompt = _build_prompt_from_schema()

    async with async_session() as db:
        if image_ids:
            result = await db.execute(
                select(Image)
                .where(Image.id.in_(image_ids))
                .where(Image.project_id == task.project_id)
            )
        else:
            result = await db.execute(
                select(Image)
                .where(Image.project_id == task.project_id)
                .where(Image.quality_status == "passed")
                .where(Image.is_kept == True)  # noqa: E712
                .where(Image.tag_status == "pending")
            )
        images = result.scalars().all()
        total = len(images)
        await progress_cb(total=total, processed=0, failed=0, cost_usd=0.0)

        if total == 0:
            if image_ids:
                reason = "所选图片不存在或不属于当前项目"
            else:
                reason = "当前项目没有同时满足“质检通过、去重保留、待打标”的图片"
            raise RuntimeError(f"没有可打标的图片：{reason}")

        # Only resolve the provider after confirming there is actual work.
        # Otherwise a no-op task can misleadingly fail on provider config
        # before we can explain that its candidate set is empty.
        provider_chain = _get_provider_chain(provider_name, fallback_name)
        active_provider_index = 0
        provider_state_lock = asyncio.Lock()

        semaphore = asyncio.Semaphore(concurrency)
        total_cost = 0.0
        processed = 0  # attempted images, including terminal failures
        succeeded = 0
        failed = 0
        failure_errors: list[str] = []
        cost_limit_reached = False
        lock = asyncio.Lock()

        async def current_provider() -> tuple[int, str, object]:
            async with provider_state_lock:
                name, provider = provider_chain[active_provider_index]
                return active_provider_index, name, provider

        async def advance_provider(failed_index: int, reason: str) -> bool:
            """Move the whole task to the next provider once.

            Several image coroutines can observe the same 403 concurrently.
            The index check prevents them from skipping multiple healthy
            fallbacks; callers that lost the race simply reuse the provider
            selected by the first coroutine.
            """
            nonlocal active_provider_index
            async with provider_state_lock:
                if active_provider_index > failed_index:
                    return True
                if active_provider_index != failed_index:
                    return False
                if active_provider_index + 1 >= len(provider_chain):
                    return False
                old_name = provider_chain[active_provider_index][0]
                active_provider_index += 1
                new_name = provider_chain[active_provider_index][0]
                logger.warning(
                    "Tagger provider failover: %s -> %s (%s)",
                    old_name,
                    new_name,
                    reason,
                )
                return True

        async def tag_one(img: Image):
            nonlocal total_cost, processed, succeeded, failed
            nonlocal cost_limit_reached

            async with semaphore:
                # Another concurrent image may have exhausted the task budget
                # while this coroutine was waiting for a slot.
                if cost_limit_reached:
                    return

                last_error = "未知错误"
                while True:
                    provider_index, attempt_provider_name, attempt_provider = await current_provider()
                    switched_provider = False

                    for attempt in range(retry_times):
                        try:
                            result = await attempt_provider.tag_image(
                                effective_file_path(img), prompt
                            )
                            tags_data = result["tags"]
                            if not isinstance(tags_data, dict):
                                raise ValueError("模型返回的 tags 不是 JSON 对象")

                            async with async_session() as inner_db:
                                # 尊重人工标签:某维若已有 manual 标签,跳过该维的 AI 值,不覆盖人工
                                manual_rows = (await inner_db.execute(
                                    select(Tag.dimension, Tag.value)
                                    .where(Tag.image_id == img.id).where(Tag.source == "manual")
                                )).all()
                                manual_dims = {d for d, _ in manual_rows}
                                missing_required = [
                                    dimension for dimension in required_dims
                                    if dimension not in manual_dims
                                    and not tags_data.get(dimension)
                                ]
                                if missing_required:
                                    raise ValueError(
                                        "模型返回缺少必填标签维度："
                                        + "、".join(sorted(missing_required))
                                    )

                                # Re-run safety: only remove the old AI tags after
                                # the provider has returned a valid replacement.
                                # A failed re-tag therefore preserves the previous
                                # usable labels instead of leaving the image blank.
                                await inner_db.execute(
                                    sa_delete(Tag)
                                    .where(Tag.image_id == img.id)
                                    .where(Tag.source == "ai")
                                )
                                tag_values: list[str] = [v for _, v in manual_rows]  # blob 含已有人工值
                                for dimension, value in tags_data.items():
                                    if dimension == "description" or dimension in manual_dims:
                                        continue
                                    if isinstance(value, list):
                                        for v in value:
                                            inner_db.add(Tag(image_id=img.id, dimension=dimension, value=v, source="ai"))
                                            tag_values.append(v)
                                    elif isinstance(value, str):
                                        inner_db.add(Tag(image_id=img.id, dimension=dimension, value=value, source="ai"))
                                        tag_values.append(value)

                                description = tags_data.get("description")
                                # 刷新 text_search_blob,文搜立即看到新标签+描述(AI/人工共用拼接)
                                text_search_blob = build_text_search_blob(img.file_name, description, tag_values)

                                await inner_db.execute(
                                    update(Image).where(Image.id == img.id).values(
                                        description=description,
                                        tag_status="tagged",
                                        tagged_at=datetime.utcnow(),
                                        tag_provider=attempt_provider_name,
                                        text_search_blob=text_search_blob,
                                    )
                                )
                                await inner_db.commit()

                            # 打标结果推云端(多人协作:别的电脑拉取后能看到标签)。
                            # push worker 只放行 approved 的图,pending 入队会被过滤,无害。
                            try:
                                from sidecar.scheduler.cloud_sync_worker import enqueue_image_upsert
                                await enqueue_image_upsert(img.id)
                            except Exception:
                                logger.debug("cloud sync enqueue failed for %s (non-fatal)", img.id)

                            async with lock:
                                total_cost += result.get("cost_usd", 0)
                                processed += 1
                                succeeded += 1
                                if total_cost >= cost_limit:
                                    cost_limit_reached = True
                                await progress_cb(
                                    processed=processed,
                                    total=total,
                                    failed=failed,
                                    cost_usd=total_cost,
                                )

                            # A/B audit — sample-rate gated, fire-and-forget
                            try:
                                from sidecar.engines.tag_audit import maybe_schedule_audit
                                maybe_schedule_audit(
                                    img.id,
                                    tags_data,
                                    attempt_provider_name,
                                    getattr(attempt_provider, "model", None),
                                    prompt=prompt,
                                )
                            except Exception as audit_err:
                                logger.debug("tag_audit scheduling failed: %s", audit_err)
                            return  # Success

                        except Exception as exc:
                            last_error = _format_provider_error(
                                attempt_provider_name, attempt_provider, exc
                            )
                            if _should_failover_immediately(exc):
                                switched_provider = await advance_provider(
                                    provider_index, last_error
                                )
                                if switched_provider:
                                    break
                            if attempt < retry_times - 1:
                                await asyncio.sleep(1 * (attempt + 1))

                    if switched_provider:
                        continue

                    # Retries were exhausted. A malformed-output or transient
                    # failure may still be provider-specific, so try the next
                    # known vision relay before failing this image.
                    if await advance_provider(provider_index, last_error):
                        continue
                    break

                # All retries failed
                async with lock:
                    failed += 1
                    processed += 1
                    failure_errors.append(last_error)
                    await progress_cb(
                        processed=processed,
                        total=total,
                        failed=failed,
                        cost_usd=total_cost,
                    )
                logger.error("Failed to tag %s after provider fallbacks: %s", img.id, last_error)

        batch_size = int(get_setting("tagger_batch_size") or 10)
        for i in range(0, total, batch_size):
            batch = images[i:i + batch_size]
            await asyncio.gather(*[tag_one(img) for img in batch])
            if cost_limit_reached:
                break

        logger.info(
            "Tagging done: %d succeeded, %d failed, %d/%d attempted, cost=$%.4f",
            succeeded, failed, processed, total, total_cost,
        )

        if failed:
            first_error = failure_errors[0][:300] if failure_errors else "未知错误"
            raise RuntimeError(
                f"打标任务未全部成功：成功 {succeeded} 张，失败 {failed} 张。"
                f"首个错误：{first_error}"
            )

        if cost_limit_reached and processed < total:
            raise RuntimeError(
                f"达到费用上限 ${total_cost:.4f}，任务已停止："
                f"成功 {succeeded}/{total} 张"
            )
