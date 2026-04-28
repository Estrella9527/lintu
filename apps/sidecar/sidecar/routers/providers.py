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
    relay_index: int | None = None  # For testing saved custom relays


@router.post("/test")
async def test_provider(body: TestProviderBody):
    """Test a provider connection by making a minimal API call."""
    try:
        if body.provider_id == "gemini":
            return await _test_gemini(body.api_key)
        elif body.provider_id == "openai_compatible":
            # If relay_index is set, read saved relay config (with full api_key)
            base_url = body.base_url
            api_key = body.api_key
            model = body.model
            if body.relay_index is not None:
                config = _read_config()
                try:
                    relays = json.loads(config.get("custom_relays", "[]"))
                    relay = relays[body.relay_index]
                    base_url = base_url or relay.get("base_url")
                    api_key = api_key or relay.get("api_key")
                    model = model or relay.get("model")
                except (json.JSONDecodeError, IndexError):
                    pass
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
        base = base_url.rstrip("/")
        # Skip /v1 prefix when base already contains a version segment
        # (e.g. Volcengine Ark /api/v3, or any /v2, /v3 base).
        if _VERSION_SEGMENT.search(base):
            url = base + "/models"
        else:
            url = base + "/v1/models"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("id", "") for m in data.get("data", [])[:5]]
                return {"ok": True, "message": f"连接成功，可用模型: {', '.join(models) or '(已获取)'}"}
            else:
                return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
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
