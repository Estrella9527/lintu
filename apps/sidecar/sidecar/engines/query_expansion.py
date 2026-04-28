"""LLM-based query expansion for text→image match.

Why expand: a single user query like "温馨亲子时光" only contains 4 keywords,
which cripples keyword-based recall. The LLM expands it into a richer cloud:

  ["温馨", "亲子", "家庭", "孩子", "陪伴", "幸福", "欢笑", "温暖",
   "天伦之乐", "家庭聚会", "妈妈", "宝宝", "笑容", "童年"]

These expansions are matched against:
  - tag values (style/mood/theme/composition/...)  ← high-signal hits
  - text_search_blob (description + filename + tags)  ← keyword density

Cache: SHA-256 of normalized query → expansion list, in-memory LRU. UGC apps
often hit the same query repeatedly; LRU saves the LLM round-trip.

Failure mode: if the LLM call fails or no general provider is configured,
return [original_query] — the matcher still works on the original text.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
from collections import OrderedDict
from typing import Optional

import httpx

from sidecar.providers.registry import get_general_provider_target

logger = logging.getLogger(__name__)


_EXPAND_PROMPT = """你是一个搜索词扩展助手。给定一段中文文本（用户描述/想要找的内容），
请提取并扩展出一组**搜索关键词**，用于在图片库中召回相关图片。

要求：
1. 提取文本里所有名词、形容词、场景词（按重要性顺序）
2. 补全同义词、近义词、相关概念词（例如「孩子→儿童、宝宝、小朋友」）
3. 加入"氛围/情绪/风格"关键词（例如「温馨、治愈、欢乐、梦幻、震撼」）
4. 加入"适用主题"关键词（例如「亲子时光、闺蜜出游、网红打卡」）
5. 控制在 15-25 个关键词；优先词放前面；**只输出 JSON 数组**

示例：
输入：「周末带孩子来这里玩了一天，秋天的山地特别美」
输出：["秋季","秋天","山地","山地景观","儿童","孩子","小朋友","亲子","家庭","周末","游玩","欢乐","温馨","户外","户外探险","山林","景观","自然","美景","治愈","休闲度假"]

现在请处理这段文本：
"""


# ── LRU cache ────────────────────────────────────────────────────────────────


class _LRUCache:
    def __init__(self, maxsize: int = 1024):
        self._d: "OrderedDict[str, tuple[float, list[str]]]" = OrderedDict()
        self._max = maxsize
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> list[str] | None:
        async with self._lock:
            if key not in self._d:
                return None
            self._d.move_to_end(key)
            return self._d[key][1]

    async def put(self, key: str, value: list[str]) -> None:
        async with self._lock:
            self._d[key] = (time.time(), value)
            self._d.move_to_end(key)
            while len(self._d) > self._max:
                self._d.popitem(last=False)


_cache = _LRUCache(maxsize=1024)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _hash_key(text: str) -> str:
    return hashlib.sha256(_normalize(text).encode("utf-8")).hexdigest()[:16]


# ── Public API ───────────────────────────────────────────────────────────────


async def expand_query(text: str, *, timeout_sec: float = 8.0) -> list[str]:
    """Return an expanded keyword list. Always returns at least [text] on failure.

    Side-effect: caches SUCCESSFUL results by SHA-256(normalized text). Failure
    results are NOT cached, so the next call retries the LLM (e.g. after
    transient relay outage).
    """
    text = (text or "").strip()
    if not text:
        return []

    cache_key = _hash_key(text)
    cached = await _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        keywords = await asyncio.wait_for(
            _expand_via_llm(text, timeout_sec=timeout_sec),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        logger.warning("query_expansion: LLM call exceeded %ss; falling back to jieba", timeout_sec)
        keywords = []
    except Exception as e:
        logger.warning("query_expansion: LLM error %s; falling back to jieba", e)
        keywords = []

    if not keywords:
        # Fallback: return [text] so caller sees it and treats as no-expansion.
        # NOT cached — next call will retry the LLM.
        return [text]

    # Always include the raw query at the front so direct hits aren't missed
    # by keyword recall when expansion drops a critical token.
    if text not in keywords:
        keywords = [text] + keywords
    await _cache.put(cache_key, keywords)
    return keywords


async def _expand_via_llm(text: str, *, timeout_sec: float) -> list[str]:
    try:
        target = get_general_provider_target()
    except Exception as e:
        logger.info("query_expansion: no general provider configured (%s); skipping", e)
        return []

    prompt = _EXPAND_PROMPT + text

    try:
        if target["type"] == "openai_compat":
            return await _expand_via_openai_compat(target, prompt, timeout_sec)
        if target["type"] == "gemini":
            return await _expand_via_gemini(target, prompt, timeout_sec)
    except Exception as e:
        logger.warning("query_expansion: LLM call failed: %s", e)
    return []


async def _expand_via_openai_compat(target: dict, prompt: str, timeout_sec: float) -> list[str]:
    base = target["base_url"].rstrip("/")
    if not re.search(r"/v\d+(?:/|$)", base):
        base = base + "/v1"
    url = base + "/chat/completions"
    headers = {"Authorization": f"Bearer {target['api_key']}", "Content-Type": "application/json"}
    body = {
        "model": target.get("model") or "doubao-seed-2-0-lite-260215",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 400,
    }
    async with httpx.AsyncClient(timeout=timeout_sec) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    return _parse_keywords(content)


async def _expand_via_gemini(target: dict, prompt: str, timeout_sec: float) -> list[str]:
    try:
        import google.generativeai as genai
        genai.configure(api_key=target["api_key"])
        model = genai.GenerativeModel(target.get("model") or "gemini-2.0-flash")
        resp = await model.generate_content_async(prompt)
        content = getattr(resp, "text", "") or ""
    except Exception as e:
        logger.warning("query_expansion: gemini failed: %s", e)
        return []
    return _parse_keywords(content)


def _parse_keywords(raw: str) -> list[str]:
    """Parse model output into a deduplicated keyword list."""
    if not raw:
        return []
    s = raw.strip()
    # Models often wrap JSON in markdown code fences
    if s.startswith("```"):
        s = s.split("```", 2)
        s = s[1] if len(s) > 1 else ""
        s = s.lstrip("json").strip()
    # Try direct JSON parse
    try:
        arr = json.loads(s)
        if isinstance(arr, list):
            return _dedupe_keywords(arr)
    except json.JSONDecodeError:
        pass
    # Try to extract a JSON array from anywhere in the text
    m = re.search(r"\[(.*?)\]", s, re.DOTALL)
    if m:
        try:
            arr = json.loads("[" + m.group(1) + "]")
            if isinstance(arr, list):
                return _dedupe_keywords(arr)
        except json.JSONDecodeError:
            pass
    # Last-ditch: split on commas / Chinese punctuation
    items = re.split(r"[,，、；;\n]+", s)
    return _dedupe_keywords(items)


def _dedupe_keywords(items) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if not isinstance(it, str):
            continue
        token = it.strip().strip('"\'').strip()
        if not token or len(token) > 30:
            continue
        norm = token.lower()
        if norm in seen:
            continue
        seen.add(norm)
        out.append(token)
    return out[:30]
