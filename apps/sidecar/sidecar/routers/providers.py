"""Provider management and connection testing."""

import json
import logging

from fastapi import APIRouter
from pydantic import BaseModel

from sidecar.routers.config_api import _read_config

logger = logging.getLogger(__name__)
router = APIRouter()


class TestProviderBody(BaseModel):
    provider_id: str
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None


@router.post("/test")
async def test_provider(body: TestProviderBody):
    """Test a provider connection by making a minimal API call."""
    try:
        if body.provider_id == "gemini":
            return await _test_gemini(body.api_key)
        elif body.provider_id == "openai_compatible":
            return await _test_openai_compatible(body.base_url, body.api_key, body.model)
        elif body.provider_id == "comfyui":
            return await _test_comfyui(body.base_url)
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
        url = base_url.rstrip("/") + "/v1/models" if "/v1" not in base_url else base_url.rstrip("/") + "/models"
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
