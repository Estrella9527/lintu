"""Provider management and connection testing."""

import json
import logging
import re

from fastapi import APIRouter
from pydantic import BaseModel

_VERSION_SEGMENT = re.compile(r"/v\d+(?:/|$)")

from sidecar.providers.registry import list_available_providers
from sidecar.routers.config_api import _read_config

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/available")
async def available_providers():
    """List all currently-configured providers (powers the role-assignment dropdowns)."""
    return list_available_providers()


class TestProviderBody(BaseModel):
    provider_id: str
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    provider_name: str | None = None  # stable relay identity; matches runtime lookup
    relay_index: int | None = None  # For testing saved custom relays


@router.post("/test")
async def test_provider(body: TestProviderBody):
    """Test a provider connection by making a minimal API call."""
    try:
        if body.provider_id == "gemini":
            return await _test_gemini(body.api_key)
        elif body.provider_id == "openai_compatible":
            # Resolve saved relays by name, just like the runtime tagger. Index
            # remains for old clients, but can point at the wrong token after
            # another device inserts/reorders relay entries.
            base_url = body.base_url
            api_key = body.api_key
            model = body.model
            if body.provider_name or body.relay_index is not None:
                config = _read_config()
                try:
                    relays = json.loads(config.get("custom_relays", "[]"))
                    if body.provider_name:
                        relay = next(
                            r for r in relays
                            if r.get("name") == body.provider_name
                        )
                    else:
                        relay = relays[body.relay_index]
                    base_url = base_url or relay.get("base_url")
                    api_key = api_key or relay.get("api_key")
                    model = model or relay.get("model")
                except (json.JSONDecodeError, IndexError, StopIteration, TypeError):
                    return {
                        "ok": False,
                        "error": f"未找到服务商：{body.provider_name or body.relay_index}",
                    }
            return await _test_openai_compatible(base_url, api_key, model)
        elif body.provider_id == "comfyui":
            return await _test_comfyui(body.base_url)
        elif body.provider_id in ("openai", "qwen_vl", "jimeng", "tongyi_wanxiang", "zhipu"):
            # For providers that use simple API key, just verify key is set
            key = body.api_key or _read_config().get(f"{body.provider_id}_api_key", "")
            if key:
                return {"ok": True, "message": f"API Key 已配置（{len(key)}字符）"}
            return {"ok": False, "error": "未提供 API Key"}
        else:
            return {"ok": False, "error": f"未知的 Provider: {body.provider_id}"}
    except Exception as e:
        logger.error(f"Provider test failed: {e}")
        return {"ok": False, "error": str(e)}


async def _test_gemini(api_key: str | None):
    key = api_key or _read_config().get("gemini_api_key", "")
    if not key:
        return {"ok": False, "error": "未提供 API Key"}
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        response = await model.generate_content_async("Say OK")
        return {"ok": True, "message": f"连接成功，模型响应: {response.text[:50]}"}
    except ImportError:
        return {"ok": False, "error": "google-generativeai 未安装，请运行: uv add google-generativeai"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _test_openai_compatible(base_url: str | None, api_key: str | None, model: str | None):
    if not base_url:
        return {"ok": False, "error": "未提供 Base URL"}
    if not api_key:
        return {"ok": False, "error": "未提供 API Key"}
    try:
        import httpx

        def endpoint(path: str) -> str:
            base = base_url.rstrip("/")
            # Skip /v1 prefix when caller already supplied a versioned base
            # (Volcengine Ark /api/v3, custom /v2, etc.).
            return base + path if _VERSION_SEGMENT.search(base) else base + "/v1" + path

        def response_message(response: httpx.Response) -> str:
            try:
                data = response.json()
                if isinstance(data, dict):
                    error = data.get("error")
                    if isinstance(error, dict) and error.get("message"):
                        return str(error["message"])[:300]
                    if isinstance(error, str):
                        return error[:300]
                    if data.get("message"):
                        return str(data["message"])[:300]
            except ValueError:
                pass
            return response.text.strip()[:300]

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        available_models: list[str] = []
        model_list_status: int | None = None
        async with httpx.AsyncClient(timeout=30) as client:
            # Model listing is useful diagnostics, but it is not a successful
            # health check: many gateways list models that this token cannot
            # invoke, or have no live distributor behind a listed model.
            models_resp = await client.get(endpoint("/models"), headers=headers)
            model_list_status = models_resp.status_code
            if models_resp.status_code == 200:
                try:
                    payload = models_resp.json()
                    available_models = [
                        str(item.get("id"))
                        for item in payload.get("data", [])
                        if isinstance(item, dict) and item.get("id")
                    ]
                except (ValueError, AttributeError):
                    available_models = []

            if not model:
                if models_resp.status_code == 200:
                    return {
                        "ok": False,
                        "error": "连接成功，但未配置模型；无法验证真实调用",
                        "available_models": available_models[:20],
                    }
                return {
                    "ok": False,
                    "error": f"模型列表请求失败（HTTP {models_resp.status_code}）：{response_message(models_resp)}",
                }

            model_lower = model.lower()
            non_chat_model = any(hint in model_lower for hint in (
                "embedding", "seedream", "gpt-image", "dall-e", "imagen", "flux",
            ))
            if non_chat_model:
                if available_models and model not in available_models:
                    return {
                        "ok": False,
                        "error": f"令牌可连接，但模型 {model} 不在可用模型列表中",
                        "available_models": available_models[:20],
                    }
                return {
                    "ok": models_resp.status_code == 200,
                    "message": (
                        f"连接成功，模型 {model} 可见；为避免计费，未执行生成/向量调用"
                        if models_resp.status_code == 200
                        else None
                    ),
                    "error": (
                        None if models_resp.status_code == 200
                        else f"模型列表请求失败（HTTP {models_resp.status_code}）"
                    ),
                    "verified": "listing_only",
                }

            # Real, minimal multimodal request. This deliberately mirrors the
            # tagger's endpoint, auth header, model field, image payload and
            # max_tokens parameter so "测试成功" means tagging can really call.
            # 16x16 neutral PNG. Ark rejects images below 14px; keeping the
            # probe tiny avoids bandwidth/cost while exercising vision input.
            tiny_png = (
                "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNsaGhg"
                "IAUwkaSaYVQDcYCJSHVwMKqBGEByKAEAyUwBoHKcrY0AAAAASUVORK5CYII="
            )
            call_resp = await client.post(
                endpoint("/chat/completions"),
                headers=headers,
                json={
                    "model": model,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "只回复 OK"},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{tiny_png}"},
                            },
                        ],
                    }],
                    "max_tokens": 16,
                },
            )

        if call_resp.status_code == 200:
            return {
                "ok": True,
                "message": f"真实视觉调用成功：{model}",
                "model": model,
                "verified": "vision_call",
            }

        listing_hint = ""
        if available_models and model not in available_models:
            listing_hint = (
                f"；该令牌可见模型：{', '.join(available_models[:5])}"
            )
        elif model_list_status and model_list_status != 200:
            listing_hint = f"；模型列表接口 HTTP {model_list_status}"
        return {
            "ok": False,
            "error": (
                f"模型 {model} 真实视觉调用失败（HTTP {call_resp.status_code}）："
                f"{response_message(call_resp)}{listing_hint}"
            ),
            "model": model,
            "verified": "vision_call",
            "available_models": available_models[:20],
        }
    except ImportError:
        return {"ok": False, "error": "httpx 未安装"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def _test_comfyui(base_url: str | None):
    if not base_url:
        return {"ok": False, "error": "未提供 ComfyUI 地址"}
    try:
        import httpx
        url = base_url.rstrip("/") + "/system_stats"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                return {"ok": True, "message": "ComfyUI 连接成功"}
            else:
                return {"ok": False, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
