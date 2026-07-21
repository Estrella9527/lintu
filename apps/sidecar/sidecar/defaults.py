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
    # Empty by default — tagger now reads default_general_provider (the
    # role-assignment UI). Setting this forces a specific tagger provider
    # regardless of the role-assignment, but no one should set it on a
    # fresh install.
    "tagger_provider": "",
    "tagger_fallback_provider": "",
    # 真实视觉请求通常需要 40-90 秒。官方模型在 10 路并发时容易排队到
    # 客户端读超时；桌面端默认保持 6 路，仍允许运营按渠道配额手动调高。
    "tagger_batch_size": 6,
    "tagger_max_concurrent": 6,
    "tagger_retry_times": 3,
    "tagger_request_timeout_seconds": 180,
    "tagger_cost_limit_usd": 50.0,

    # ── Image generation ──
    "generation_model": "nano-banana-2",
    "generation_max_retries": 2,                   # per-provider retries before next provider in chain
    "generation_min_output_bytes": 16384,          # below this we treat output as invalid (raised — 4K outputs are ~1MB+)
    "allow_pil_fallback_in_batch": False,          # batch mode skips PIL — only AI counts

    # Output resolution. Forwarded as `size` to gpt-image / Seedream / etc.
    # Accepted forms:
    #   "2048x2048" / "1536x1024"  → exact (most providers)
    #   "1K" / "2K" / "4K"          → Seedream shorthand (auto-mapped)
    #   ""                           → provider-specific default (gpt-image: 2048x2048, Seedream: 4K)
    "image_output_size": "",

    # Upload size gate — guards the ORIGINAL-bytes generation path. When a
    # seed image's raw bytes exceed `upload_max_bytes`, providers apply
    # `upload_oversize_policy`:
    #   "fail"   → raise PermanentError; subtask surfaces so user fixes source
    #   "shrink" → progressively downscale until it fits (LOSSY fallback)
    # 0 disables the gate. Default 25MB covers most relay 20MB caps with
    # a small safety margin; set to 0 on relays with no cap.
    # 默认 "shrink":相机原片普遍 >25MB,硬失败会让运营误以为"生成不了"。
    # 自动降采样到限内再发(仅作为入参送模型,本地原图不动),保证可生成。
    "upload_max_bytes": 25 * 1024 * 1024,
    "upload_oversize_policy": "shrink",

    # ── Provider role assignment (Phase 2) ──
    # Identifier format: "gemini" or "relay:<relay_name>". Empty string =
    # auto-pick (first relay, then gemini fallback).
    "default_general_provider": "",                # high-frequency vision: 打标 / 方向矫正
    "default_image_provider": "",                  # image-to-image generation
    "default_parser_provider": "",                 # long-context structured doc parsing
    "general_provider_model": "",                  # optional model override for general role
    "parser_provider_model": "",                   # optional model override for parser role

    # Image embedding source (Phase 2):
    #   ""           → local CLIP via open_clip_torch (free, ~5-10 min for 7k imgs on MPS)
    #   "relay:xxx"  → remote /v1/embeddings on a relay configured for image embedding
    #                  (e.g. Volcengine Ark `doubao-embedding-vision-*`)
    "default_image_embedding_provider": "",
    "image_embedding_model_override": "",          # optional model name override

    # ── Tagger A/B audit ──
    # Cross-validate a sample of primary-tagged images against a stronger
    # provider and compute Jaccard agreement. Surfaces drift / quality issues.
    "tagger_audit_provider": "",                   # "" disables audit; "gemini" or "relay:<name>"
    "tagger_audit_sample_rate": 0.05,              # fraction of newly-tagged images to audit (0..1)
    "tagger_audit_model_override": "",             # optional model name override for audit

    # ── Object storage / CDN (S5.2) ──
    # When oss_provider is set, scan/batch hooks enqueue uploads to oss_sync_jobs;
    # OssSyncWorker drains the queue and stamps Image.cdn_path. The Open API
    # then returns CDN URLs to external callers (rather than streaming from
    # local sidecar). Empty provider = feature disabled (current behaviour).
    "oss_provider": "",                            # "" | "aliyun"
    "oss_endpoint": "",                            # e.g. "oss-cn-hangzhou.aliyuncs.com"
    "oss_bucket": "",
    "oss_access_key": "",                          # mask-protected on GET /api/config
    "oss_access_secret": "",                       # mask-protected on GET /api/config
    "oss_cdn_base": "",                            # "https://cdn.lintu.com" — empty falls back to bucket URL
    "oss_signed_url_ttl_sec": 0,                   # 0 = public bucket; >0 = signed URLs of N seconds

    # ── Text → Image match (S5.3) ──
    # match_strategy_weights overrides the per-call strategy preset; leave
    # empty to use the preset chosen by the request body. match_max_limit
    # caps `limit` so external clients can't request 10000-image batches.
    "match_strategy_weights": {},
    "match_default_limit": 8,
    "match_max_limit": 50,

    # ── Coverage matrix ──
    "matrix_row_dimension": "season",
    "matrix_col_dimension": "scene",
    "matrix_p0_threshold": 50,
    "matrix_p1_threshold": 200,

    # ── 多设备同步(拉取端开关;推送始终开) ──
    # 打开后本机定期从云端拉回其他电脑「已审核发布」的图与标签。
    "cloud_pull_enabled": False,

    # ── 按操作路由 ──
    # 「中文文字」操作默认走文字渲染强的供应商(Seedream/即梦同源)。
    # 名字对应 设置→AI 服务商 里的 relay 名;不存在时自动退回默认链。
    "text_render_provider": "relay:ark-image",
    # 导出 SVG 默认走 ChatGPT 类模型按提示词直接生成矢量代码(6.11)。
    "svg_provider": "relay:gpt5.5",
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
