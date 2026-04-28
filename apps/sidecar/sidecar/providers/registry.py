"""Provider registry — instantiates providers by name and builds chains.

Two roles are tracked, both honoring user assignment in config.json:

  - **general**  — chat / vision / parsing / OCR (anything that returns text)
                   Config key: `default_general_provider`
  - **image**    — image-to-image generation
                   Config key: `default_image_provider`

Provider identifiers:
  - "gemini"           → GeminiProvider
  - "relay:<name>"     → custom relay matching that name
  - "<relay-name>"     → bare relay name (legacy form, also accepted)

If the configured default provider is unavailable, callers get the first
configured relay, then Gemini, in that order.
"""
from __future__ import annotations

import json
import logging

from sidecar.providers.base import ImageProvider

logger = logging.getLogger(__name__)


def _read_config() -> dict:
    from sidecar.routers.config_api import _read_config as _r
    return _r()


def _list_relays(config: dict) -> list[dict]:
    raw = config.get("custom_relays", "[]")
    try:
        relays = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except json.JSONDecodeError:
        relays = []
    return [r for r in relays if r.get("base_url") and r.get("api_key")]


def _strip_relay_prefix(name: str) -> str:
    return name[len("relay:"):] if name.startswith("relay:") else name


def get_provider(name: str, *, image_model: str | None = None) -> ImageProvider:
    """Instantiate a single provider by name.

    Raises ValueError if the named provider can't be configured.
    """
    config = _read_config()

    if name == "gemini":
        api_key = config.get("gemini_api_key", "")
        if not api_key:
            raise ValueError("Gemini API key not configured")
        from sidecar.providers.gemini import GeminiProvider
        p = GeminiProvider(api_key=api_key)
        p.name = "gemini"
        return p

    name = _strip_relay_prefix(name)
    relays = _list_relays(config)
    relay = next((r for r in relays if r.get("name") == name), None)
    if relay is None:
        raise ValueError(f"Provider '{name}' not configured")

    from sidecar.providers.openai_compat import OpenAICompatProvider
    p = OpenAICompatProvider(
        base_url=relay["base_url"],
        api_key=relay["api_key"],
        model=image_model or relay.get("model") or "gpt-4o",
    )
    p.name = relay.get("name") or "openai_compat"
    return p


# ── Role-based lookup ──────────────────────────────────────────────────────


def list_available_providers() -> list[dict]:
    """Enumerate all currently-configured providers (UI dropdown source)."""
    config = _read_config()
    out: list[dict] = []
    if config.get("gemini_api_key"):
        out.append({"id": "gemini", "name": "Google Gemini", "kind": "builtin"})
    for r in _list_relays(config):
        out.append({
            "id": f"relay:{r['name']}",
            "name": r["name"],
            "model": r.get("model"),
            "kind": "relay",
        })
    return out


def get_general_provider_target() -> dict:
    """Return raw target for the chat/vision role.

    Returns either {"type":"openai_compat", "base_url","api_key","model","name"}
    or {"type":"gemini","api_key","model","name"}. We return raw config rather
    than a ProviderInstance because prompt parsing uses chat-completions and
    multimodal calls that don't fit the ImageProvider abstraction.
    """
    config = _read_config()
    chosen = (config.get("default_general_provider") or "").strip()
    override_model = (config.get("general_provider_model") or "").strip() or None
    relays = _list_relays(config)

    def relay_target(r: dict) -> dict:
        return {
            "type": "openai_compat",
            "base_url": r["base_url"],
            "api_key": r["api_key"],
            "model": override_model or r.get("model") or "gpt-4o-mini",
            "name": r.get("name", "openai_compat"),
        }

    def gemini_target() -> dict:
        return {
            "type": "gemini",
            "api_key": config["gemini_api_key"],
            "model": override_model or "gemini-2.0-flash",
            "name": "gemini",
        }

    if chosen == "gemini" and config.get("gemini_api_key"):
        return gemini_target()
    if chosen.startswith("relay:") or (chosen and chosen != "gemini"):
        bare = _strip_relay_prefix(chosen)
        relay = next((r for r in relays if r.get("name") == bare), None)
        if relay:
            return relay_target(relay)

    # Auto: first relay → gemini
    if relays:
        return relay_target(relays[0])
    if config.get("gemini_api_key"):
        return gemini_target()
    raise RuntimeError("未配置任何通用模型 (general provider)")


def get_parser_provider_target() -> dict:
    """Long-context structured parsing target.

    Mirrors get_general_provider_target() but reads `default_parser_provider`
    and `parser_provider_model`. Falls back to the general role if the parser
    role is unset, since parsing always works with whatever vision model the
    general role uses (just at lower quality on long PDFs).
    """
    config = _read_config()
    chosen = (config.get("default_parser_provider") or "").strip()
    if not chosen:
        return get_general_provider_target()
    override_model = (config.get("parser_provider_model") or "").strip() or None
    relays = _list_relays(config)

    if chosen == "gemini" and config.get("gemini_api_key"):
        return {
            "type": "gemini",
            "api_key": config["gemini_api_key"],
            "model": override_model or "gemini-2.5-pro",
            "name": "gemini",
        }
    bare = _strip_relay_prefix(chosen)
    relay = next((r for r in relays if r.get("name") == bare), None)
    if relay:
        return {
            "type": "openai_compat",
            "base_url": relay["base_url"],
            "api_key": relay["api_key"],
            "model": override_model or relay.get("model") or "gpt-4o",
            "name": relay.get("name", "openai_compat"),
        }
    # Configured target unreachable → fall back to general
    return get_general_provider_target()


def get_image_provider_chain(*, image_model: str | None = None) -> list[ImageProvider]:
    """Ordered chain for image generation.

    1. The user's `default_image_provider` (if set and reachable)
    2. Any other configured relay/Gemini, deduplicated
    """
    config = _read_config()
    chosen = (config.get("default_image_provider") or "").strip()
    chain: list[ImageProvider] = []
    seen: set[str] = set()

    def push(p: ImageProvider) -> None:
        if p.name in seen:
            return
        seen.add(p.name)
        chain.append(p)

    if chosen:
        try:
            push(get_provider(chosen, image_model=image_model))
        except Exception as e:
            logger.warning("default_image_provider %r unavailable: %s", chosen, e)

    chosen_image_model = image_model or config.get("generation_model") or "nano-banana-2"
    from sidecar.providers.openai_compat import OpenAICompatProvider
    for relay in _list_relays(config):
        try:
            p = OpenAICompatProvider(
                base_url=relay["base_url"],
                api_key=relay["api_key"],
                model=relay.get("model") or chosen_image_model,
            )
            p.name = relay.get("name") or "openai_compat"
            push(p)
        except Exception:
            continue

    if config.get("gemini_api_key"):
        try:
            push(get_provider("gemini"))
        except Exception:
            pass

    return chain


def get_default_chain(*, image_model: str | None = None) -> list[ImageProvider]:
    """Default image-generation chain. Now delegates to role-aware lookup
    so the user's `default_image_provider` is honored everywhere."""
    return get_image_provider_chain(image_model=image_model)


def build_chain(names: list[str] | None, *, image_model: str | None = None) -> list[ImageProvider]:
    """Build a chain from explicit names. Falls back to default on None/empty."""
    if not names:
        return get_default_chain(image_model=image_model)
    chain: list[ImageProvider] = []
    for n in names:
        try:
            chain.append(get_provider(n, image_model=image_model))
        except Exception as e:
            logger.warning("Skipping provider '%s': %s", n, e)
    return chain
