"""Keyword extraction for text→image keyword recall.

Pipeline:
  1. Load tag schema → build a custom dictionary so jieba doesn't break up
     tag values like "小红书封面" or "悬崖过山车" into characters.
  2. Tokenize the input text with jieba.
  3. Match tokens (and tag-value substrings) against the tag schema, return
     the hits grouped by dimension. Plus a flat keyword list for general
     keyword search.

Why custom dictionary: jieba's default dictionary doesn't know our scenic
vocabulary; without the dictionary, "小红书封面" splits into "小红书" + "封面",
"悬崖过山车" splits into "悬崖" + "过山车", and we miss the tag match.

This module is purely synchronous CPU work — no I/O — so callers can use it
inside async handlers without await.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Iterable

import jieba

logger = logging.getLogger(__name__)


@dataclass
class KeywordExtraction:
    text: str
    tokens: list[str] = field(default_factory=list)
    # {dimension: set(values_hit)} — exact tag value matches
    tag_hits: dict[str, set[str]] = field(default_factory=dict)
    # Flat list of "interesting" tokens (excluding stopwords/single chars)
    keywords: list[str] = field(default_factory=list)

    def hit_count(self) -> int:
        return sum(len(v) for v in self.tag_hits.values())

    def all_tag_values(self) -> set[str]:
        out: set[str] = set()
        for vs in self.tag_hits.values():
            out.update(vs)
        return out


# Common Chinese stopwords (compact, focused on UGC content)
_STOPWORDS = {
    "的", "了", "和", "是", "在", "就", "都", "而", "及", "与", "或", "把", "被",
    "也", "很", "还", "已", "又", "再", "对", "从", "到", "之", "为", "上", "下",
    "里", "外", "中", "前", "后", "时", "我", "你", "他", "她", "它", "我们",
    "你们", "他们", "她们", "这", "那", "这个", "那个", "这些", "那些", "什么",
    "怎么", "如何", "为什么", "因为", "所以", "但是", "可以", "可能", "应该",
    "一", "一些", "一个", "一下", "几", "些", "个", "次", "种", "样", "件",
    "啊", "呀", "吗", "呢", "啦", "哦", "嗯", "哈", "嘿", "哟", "诶",
    "今天", "昨天", "明天", "现在", "刚", "刚刚", "突然", "马上", "立刻",
    "非常", "特别", "真的", "真是", "完全", "全部", "整个",
}


_dict_loaded = False
_dict_lock = threading.Lock()


def _ensure_dictionary_loaded() -> None:
    """Lazy-load tag values into jieba dictionary on first use. Idempotent."""
    global _dict_loaded
    if _dict_loaded:
        return
    with _dict_lock:
        if _dict_loaded:
            return
        try:
            from sidecar.routers.tag_schema import _read_schema
            schema = _read_schema()
            for dim_def in schema.values():
                for value in dim_def.get("values", []):
                    if value:
                        # high frequency = jieba prefers this segmentation
                        jieba.add_word(value, freq=10000)
            _dict_loaded = True
            logger.info("keyword_extract: jieba dictionary primed with tag schema")
        except Exception as e:
            logger.warning("keyword_extract: dictionary prime failed: %s", e)
            _dict_loaded = True  # don't keep retrying


def _build_value_index() -> dict[str, str]:
    """Map every tag value → its dimension. Cached per-call cheap enough."""
    try:
        from sidecar.routers.tag_schema import _read_schema
        schema = _read_schema()
    except Exception:
        return {}
    index: dict[str, str] = {}
    for dim_name, dim_def in schema.items():
        for value in dim_def.get("values", []):
            if value:
                index[value] = dim_name
    return index


# Synonym expansions for natural-language → tag mapping. The user often
# writes informal terms ("傍晚" instead of "黄昏"); these mappings let the
# keyword recall hit even when the exact tag value isn't in the text.
#
# Built-in defaults seed the file on first use; ops can extend them via the
# 设置 → 标签体系 → 同义词 panel without redeploying.
_SYNONYMS_DEFAULT: dict[str, str] = {
    # season
    "春天": "春季", "夏天": "夏季", "秋天": "秋季", "冬天": "冬季",
    # weather
    "晴朗": "晴天", "晴": "晴天", "下雨": "雨天", "雾气": "雾天",
    "傍晚": "黄昏", "夜晚": "夜景", "晚上": "夜景", "夜里": "夜景",
    # people
    "没人": "无人", "空无一人": "无人", "几个人": "少量游客",
    "游客": "少量游客", "小朋友": "儿童", "孩子": "儿童", "宝宝": "儿童",
    # angle
    "鸟瞰": "航拍", "航拍图": "航拍", "无人机": "航拍",
    # scene
    "山景": "山地景观", "山顶": "山地景观", "森林": "森林步道",
    "湖泊": "水域", "河流": "水域", "溪流": "水域",
}

_synonyms_cache: dict[str, str] = {}
_synonyms_cache_version: int = -1
_synonyms_cache_lock = threading.Lock()


def _get_synonyms() -> dict[str, str]:
    """Merge persisted entries on top of the built-in defaults. Cached by the
    file's version number so the in-process map updates without a restart
    whenever ops save a change."""
    global _synonyms_cache, _synonyms_cache_version
    try:
        from sidecar.routers.match_synonyms import (
            get_runtime_synonyms,
            get_runtime_version,
        )
        version = get_runtime_version()
        if version != _synonyms_cache_version:
            with _synonyms_cache_lock:
                if version != _synonyms_cache_version:
                    merged = dict(_SYNONYMS_DEFAULT)
                    merged.update(get_runtime_synonyms())
                    _synonyms_cache = merged
                    _synonyms_cache_version = version
        return _synonyms_cache
    except Exception:
        return dict(_SYNONYMS_DEFAULT)


def extract(text: str) -> KeywordExtraction:
    """Tokenize text + identify tag-value hits.

    Side-effects: primes jieba dictionary on first call (one-shot).
    """
    _ensure_dictionary_loaded()
    res = KeywordExtraction(text=text or "")
    if not text or not text.strip():
        return res

    # Apply synonym substitution BEFORE tokenization so jieba's added-word
    # bias picks up the canonical tag value.
    canonical = text
    for src, dst in _get_synonyms().items():
        if src in canonical:
            canonical = canonical.replace(src, dst)

    raw_tokens = list(jieba.cut(canonical))
    res.tokens = raw_tokens

    # Filter for "real" keywords. Single-char Chinese tokens are usually
    # noise ("带" / "美" / "得"); keep single-char only if it's ASCII (so
    # numeric / alphabetic tokens still pass).
    res.keywords = [
        t.strip() for t in raw_tokens
        if t.strip() and t.strip() not in _STOPWORDS
        and (len(t.strip()) >= 2 or t.strip().isascii())
    ]

    # Tag value hits — match tokens against schema values, AND fall back to
    # substring containment for values that may be sub-strings of longer
    # tokens (rare, but cheap).
    value_to_dim = _build_value_index()
    for token in res.keywords:
        if token in value_to_dim:
            res.tag_hits.setdefault(value_to_dim[token], set()).add(token)

    # Substring sweep — catches values that didn't tokenize cleanly
    for value, dim in value_to_dim.items():
        if value in canonical and value not in res.tag_hits.get(dim, set()):
            res.tag_hits.setdefault(dim, set()).add(value)

    return res


def keyword_text_score(query_tokens: Iterable[str], blob: str) -> float:
    """Cheap text-side recall score: fraction of query keywords appearing in blob.

    Used inside match_strategy when we need a fallback signal for an image
    that the embedding model didn't rank highly. NOT a great recall on its
    own — only complements embedding similarity.
    """
    blob_lower = (blob or "").lower()
    if not blob_lower:
        return 0.0
    qs = [t.lower() for t in query_tokens if t]
    if not qs:
        return 0.0
    hits = sum(1 for t in qs if t in blob_lower)
    return hits / len(qs)
