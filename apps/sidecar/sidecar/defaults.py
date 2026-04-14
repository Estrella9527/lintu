"""Default configuration values. Read from ~/lintu-data/config.json at runtime,
falling back to these defaults. Engines should call get_config() instead of
hardcoding values."""

import json
from sidecar.config import DATA_DIR

CONFIG_FILE = DATA_DIR / "config.json"

DEFAULTS = {
    # ── Quality check ──
    "quality_min_resolution": 720,
    "quality_blur_threshold": 80,
    "quality_brightness_min": 30,
    "quality_brightness_max": 225,
    "quality_min_file_size_kb": 50,
    "quality_supported_formats": ".jpg,.jpeg,.png,.webp,.heic,.bmp,.tiff,.tif",

    # ── Dedup ──
    "dedup_phash_threshold": 10,
    "dedup_keep_strategy": "highest_quality",

    # ── Tagger ──
    "tagger_provider": "gemini",
    "tagger_fallback_provider": "",
    "tagger_batch_size": 10,
    "tagger_max_concurrent": 5,
    "tagger_retry_times": 3,
    "tagger_cost_limit_usd": 50.0,

    # ── Image generation ──
    "generation_model": "nano-banana-2",

    # ── Coverage matrix ──
    "matrix_row_dimension": "season",
    "matrix_col_dimension": "scene",
    "matrix_p0_threshold": 50,
    "matrix_p1_threshold": 200,
}


def get_setting(key: str):
    """Read a single config value: config.json overrides DEFAULTS."""
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text())
            if key in data:
                return data[key]
        except (json.JSONDecodeError, TypeError):
            pass
    return DEFAULTS.get(key)
