import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _uid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


# ── Project (Phase 1: single project) ──


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=_uid)
    name = Column(String, nullable=False)
    originals_path = Column(String, nullable=False)
    workspace_path = Column(String, nullable=False)
    # Optional accent color (hex like "#7c3aed") shown next to the project
    # name in the sidebar selector. Pure visual — no behavioral effect.
    color = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)


# ── Image ──


class Image(Base):
    __tablename__ = "images"

    id = Column(String, primary_key=True, default=_uid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)

    # File info
    file_path = Column(String, nullable=False)
    file_name = Column(String, nullable=False)
    file_hash = Column(String, index=True)
    phash = Column(String, index=True)
    file_size_kb = Column(Integer)
    width = Column(Integer)
    height = Column(Integer)

    # Quality check
    blur_score = Column(Float)
    brightness = Column(Float)
    quality_status = Column(String, default="pending", index=True)
    reject_reason = Column(String)

    # Dedup
    dedup_group_id = Column(String, index=True)
    is_kept = Column(Boolean, default=True)

    # Tagging
    tag_status = Column(String, default="pending", index=True)
    tagged_at = Column(DateTime)
    tag_provider = Column(String)
    description = Column(Text)

    # Lineage
    source_type = Column(String, default="original")
    parent_id = Column(String, ForeignKey("images.id"))

    # Phase 2: preserve the original folder layout from the source directory
    # so users can browse / filter by 景点 / scene folder name.
    # Example values:  "【1】悬崖过山车"  "【2】路极飞车/航拍"  ""(root)
    relative_dir = Column(String, default="", index=True)

    # Phase 2: orientation pipeline bookkeeping.
    # "none" = not checked yet. "exif" = fixed via EXIF. "ai" = fixed via
    # vision-model decision. "skipped" = AI was asked, said 'correct'.
    orient_status = Column(String, default="none", index=True)

    # Lossless rotated derivative. When orient rotates an image, it writes to
    # workspace/derived/orient/{id}.{ext} (JPEG via jpegtran when possible;
    # otherwise PIL at max quality for the native format). `file_path` is
    # never overwritten. Consumers must read via effective_file_path().
    rotated_file_path = Column(String)

    # Public CDN object key (relative to oss_cdn_base). Populated by
    # OssSyncWorker after a successful upload; openapi_v1 prefers this over
    # the local /file endpoint when present. NULL = not yet uploaded.
    cdn_path = Column(String)

    # Concatenated text blob used for keyword recall in text→image match.
    # Format: "{file_name}\n{description}\n{tag_value}, {tag_value}, ..."
    # Refreshed by tagger / dedup / scan when the underlying signals change;
    # also a one-shot backfill script populates it for existing rows.
    text_search_blob = Column(Text)

    # Phase 2: semantic embedding for CLIP-based dedup.
    # Raw float16/float32 bytes (np.ndarray.tobytes()); empty = not computed.
    embedding = Column(Text)                                # stored as base64 to keep sqlite-friendly
    embedding_model = Column(String)                        # e.g. "clip-ViT-B-32" + dtype tag

    # Phase 2: full provenance for AI-generated images. Populated by
    # BatchScheduler when source_type='generated'. Schema:
    #   { provider, model, prompt_id, prompt_name, prompt_content,
    #     batch_id, batch_name, seed_image_id, cost_usd, latency_ms,
    #     generated_at, retry_count }
    generation_metadata = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    tags = relationship("Tag", back_populates="image", cascade="all, delete-orphan")


Index("idx_images_project_status", Image.project_id, Image.quality_status, Image.tag_status)


# ── Tag ──


class Tag(Base):
    __tablename__ = "tags"

    id = Column(String, primary_key=True, default=_uid)
    image_id = Column(String, ForeignKey("images.id"), nullable=False)
    dimension = Column(String, nullable=False, index=True)
    value = Column(String, nullable=False, index=True)
    confidence = Column(Float)
    source = Column(String, default="ai")

    image = relationship("Image", back_populates="tags")


Index("idx_tag_dim_val", Tag.dimension, Tag.value)


# ── Task ──


class Task(Base):
    __tablename__ = "tasks"

    id = Column(String, primary_key=True, default=_uid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    type = Column(String, nullable=False)
    status = Column(String, default="queued", index=True)
    parameters = Column(Text)

    total = Column(Integer, default=0)
    processed = Column(Integer, default=0)
    failed = Column(Integer, default=0)

    cost_usd = Column(Float, default=0.0)

    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)

    error_message = Column(Text)

    # Phase 2 — link top-level Task row to its BatchRun for batch generation
    batch_id = Column(String, ForeignKey("batch_runs.id"), index=True)


# ── Duplicate Group ──


# ── Prompt Template ──


class Prompt(Base):
    __tablename__ = "prompts"

    id = Column(String, primary_key=True, default=_uid)
    name = Column(String, nullable=False)
    category = Column(String, nullable=False, index=True)  # tagging/seasonal/style/...
    content = Column(Text, nullable=False)
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Phase 2 — Prompt as first-class
    task_type = Column(String, index=True)              # outpaint/style/seasonal/inpaint/custom/parse_prompt/tag
    negative_prompt = Column(Text)
    variables = Column(JSON)                            # [{name, type, options}]
    source = Column(String, default="manual")           # manual/imported/ai_generated
    source_doc_id = Column(String)                      # references prompt_docs.id (no FK — soft link)
    tags = Column(JSON)                                 # ["小红书","竖版"]
    stats = Column(JSON)                                # {success_count, fail_count, avg_cost_usd, last_used_at}
    is_active = Column(Boolean, default=True, index=True)
    version = Column(Integer, default=1)
    parent_id = Column(String, ForeignKey("prompts.id"))


# ── Prompt Doc (Phase 2: imported documents) ──


class PromptDoc(Base):
    __tablename__ = "prompt_docs"

    id = Column(String, primary_key=True, default=_uid)
    filename = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    format = Column(String, nullable=False)               # md/docx/xlsx/txt
    parse_status = Column(String, default="pending", index=True)  # pending/parsing/success/failed
    parsed_count = Column(Integer, default=0)
    raw_content = Column(Text)                            # original content for audit
    parsed_payload = Column(JSON)                         # parser output: [{name, content, ...}]
    parse_error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ── Strategy (AI Workshop) ──


class Strategy(Base):
    __tablename__ = "strategies"

    id = Column(String, primary_key=True, default=_uid)
    name = Column(String, nullable=False)
    icon_keyword = Column(String, default="")  # keyword for auto icon matching
    task_type = Column(String, nullable=False)  # engine task type: seasonal/style/outpaint/inpaint/crop/upscale/marketing/custom
    prompt = Column(Text, default="")  # default prompt template
    parameters = Column(Text, default="[]")  # JSON array of FieldConfig
    sort_order = Column(Integer, default=0)
    is_builtin = Column(Boolean, default=False)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ── Duplicate Group ──


class DuplicateGroup(Base):
    __tablename__ = "duplicate_groups"

    id = Column(String, primary_key=True, default=_uid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    kept_image_id = Column(String, ForeignKey("images.id"))
    image_count = Column(Integer)
    avg_hamming_distance = Column(Float)
    created_at = Column(DateTime, default=datetime.utcnow)


# ── BatchRun + Subtasks (Phase 2: 12000-image production) ──


class BatchRun(Base):
    __tablename__ = "batch_runs"

    id = Column(String, primary_key=True, default=_uid)
    project_id = Column(String, ForeignKey("projects.id"), nullable=False)
    name = Column(String, nullable=False)
    task_type = Column(String, nullable=False)            # primary engine task_type
    strategy_id = Column(String, ForeignKey("strategies.id"))
    seed_image_ids = Column(JSON, nullable=False)         # [img_id, ...]
    prompt_ids = Column(JSON, nullable=False)             # [prompt_id, ...]

    total = Column(Integer, default=0)
    completed = Column(Integer, default=0)
    failed = Column(Integer, default=0)
    skipped = Column(Integer, default=0)

    status = Column(String, default="pending", index=True)  # pending/running/paused/completed/failed/cancelled
    concurrency = Column(Integer, default=10)
    max_retry = Column(Integer, default=3)
    provider_chain = Column(JSON)                          # ["gemini","openai_compat"]
    budget_usd = Column(Numeric(10, 2))                    # null = no cap
    cost_usd = Column(Numeric(10, 4), default=0)

    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class BatchSubtask(Base):
    __tablename__ = "batch_subtasks"

    id = Column(String, primary_key=True, default=_uid)
    batch_id = Column(String, ForeignKey("batch_runs.id"), nullable=False, index=True)
    seed_image_id = Column(String, ForeignKey("images.id"), nullable=False)
    prompt_id = Column(String, ForeignKey("prompts.id"), nullable=False)
    status = Column(String, default="pending", index=True)  # pending/running/success/failed/retrying/skipped
    retry_count = Column(Integer, default=0)
    output_image_id = Column(String, ForeignKey("images.id"))
    cost_usd = Column(Numeric(10, 4))
    error_message = Column(Text)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)


Index("idx_batch_subtasks_batch_status", BatchSubtask.batch_id, BatchSubtask.status)


# ── API Key + Request Log (Phase 2: Open API for H5 / 3rd-party) ──


class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(String, primary_key=True, default=_uid)
    key_id = Column(String, nullable=False, unique=True, index=True)   # public, e.g. "lk_live_abc..."
    key_secret_hash = Column(String, nullable=False)                   # SHA256 of secret
    name = Column(String, nullable=False)
    client_type = Column(String, default="server")                     # h5/server/app
    allowed_origins = Column(JSON)                                     # ["https://sandu-h5.com"]
    allowed_ips = Column(JSON)
    scopes = Column(JSON)                                              # ["images:read","tags:read"]
    rate_limit = Column(JSON)                                          # {per_minute, per_day}
    quota_used = Column(JSON)                                          # {today, month}  (counters reset elsewhere)
    expires_at = Column(DateTime)
    is_active = Column(Boolean, default=True, index=True)
    created_by = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_used_at = Column(DateTime)


class ApiRequestLog(Base):
    __tablename__ = "api_request_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key_id = Column(String, index=True)              # public key_id (not FK — keys can be deleted)
    method = Column(String)
    path = Column(String)
    status_code = Column(Integer, index=True)
    ip = Column(String)
    user_agent = Column(Text)
    request_body = Column(JSON)
    response_size = Column(Integer)
    latency_ms = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


Index("idx_api_logs_key_time", ApiRequestLog.key_id, ApiRequestLog.created_at)


class ApiKeyUsageDaily(Base):
    """Persistent per-day call counter, populated by QuotaMiddleware on every
    /open-api/* request. Used for (a) enforcing daily quota beyond process
    restarts (rate_limit middleware is in-memory only), (b) DistributionCenter
    usage chart, (c) future billing.

    PRIMARY KEY (key_id, date) means UPSERT updates the existing row.
    """
    __tablename__ = "api_key_usage_daily"

    key_id = Column(String, primary_key=True)
    date = Column(String, primary_key=True)        # YYYY-MM-DD (UTC)
    count = Column(Integer, default=0, nullable=False)
    error_count = Column(Integer, default=0, nullable=False)
    cost_estimate_usd = Column(Numeric(10, 4), default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


Index("idx_api_usage_key_date", ApiKeyUsageDaily.key_id, ApiKeyUsageDaily.date)


class OssSyncJob(Base):
    """Pending or in-flight OSS upload. The OssSyncWorker pulls rows in
    `pending` order, attempts upload, marks `done` or bumps `attempts` on
    failure. We intentionally enqueue THREE rows per new image (original +
    300px thumb + 800px thumb) so partial failures are recoverable.
    """
    __tablename__ = "oss_sync_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    image_id = Column(String, ForeignKey("images.id"), index=True, nullable=False)
    asset_kind = Column(String, nullable=False)        # 'original' | 'thumb_300' | 'thumb_800'
    object_key = Column(String, nullable=False)        # destination key in bucket
    local_path = Column(String, nullable=False)        # source file on local disk
    content_type = Column(String, nullable=False)
    status = Column(String, default="pending", index=True)  # pending|running|done|failed|skipped
    attempts = Column(Integer, default=0, nullable=False)
    last_error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime)


Index("idx_oss_sync_status_created", OssSyncJob.status, OssSyncJob.created_at)


class CloudSyncJob(Base):
    """Pending or in-flight local→cloud sync event. CloudSyncWorker drains
    this in `pending` order, batches by entity_type, POSTs to the cloud
    sidecar's /internal/sync/* endpoints. Persisted so app restart never
    loses an unsynced write."""
    __tablename__ = "cloud_sync_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entity_type = Column(String, nullable=False, index=True)   # 'image'|'project'|'api_key'|'synonyms'|'tag_schema'
    entity_id = Column(String, index=True)                     # NULL for whole-dict syncs
    op = Column(String, nullable=False)                        # 'upsert' | 'delete'
    status = Column(String, default="pending", index=True)
    attempts = Column(Integer, default=0)
    error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


Index("idx_cloud_sync_status_created", CloudSyncJob.status, CloudSyncJob.created_at)


class MatchFeedback(Base):
    """One row per (matched image, optional 'was_chosen' flag) emitted from
    the UGC app via POST /open-api/v1/images/{id}/track-usage. Used to
    measure precision and (later) tune match_strategy weights.

    text_hash is sha256(query_text)[:16] so we can group repeated queries
    without storing the raw text indefinitely.
    """
    __tablename__ = "match_feedback"

    id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(String, index=True)
    api_key_id = Column(String, index=True)
    text_hash = Column(String, index=True)
    image_id = Column(String, ForeignKey("images.id"), index=True)
    rank = Column(Integer)             # 1-based position in returned ranked list
    score = Column(Float)              # final score reported to the client
    was_chosen = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


Index("idx_match_feedback_key_time", MatchFeedback.api_key_id, MatchFeedback.created_at)


class TagAuditLog(Base):
    __tablename__ = "tag_audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    image_id = Column(String, nullable=False, index=True)
    primary_provider = Column(String, nullable=False)
    primary_model = Column(String)
    primary_tags = Column(JSON, nullable=False)         # {dimension: [values]}
    audit_provider = Column(String, nullable=False)
    audit_model = Column(String)
    audit_tags = Column(JSON, nullable=False)
    jaccard = Column(Float, nullable=False)             # overall agreement 0..1
    per_dimension = Column(JSON)                        # {dim: jaccard}
    status = Column(String, default="ok")               # ok | mismatch | error
    error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


Index(
    "idx_tag_audit_provider_time",
    TagAuditLog.primary_provider,
    TagAuditLog.created_at,
)
