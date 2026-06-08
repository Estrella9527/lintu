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
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _uid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


# ── Project ──


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=_uid)
    # v0.2 起所有 project 必须归属一个 organization。迁移时所有现有 project
    # 会被归到 default-org（迁移脚本写死的 sentinel id）。FK 不设 cascade —
    # 删组织前必须先处理项目，避免误删 4500 张图。
    org_id = Column(String, ForeignKey("organizations.id"), index=True)
    name = Column(String, nullable=False)
    originals_path = Column(String, nullable=False)
    workspace_path = Column(String, nullable=False)
    # Optional accent color (hex like "#7c3aed") shown next to the project
    # name in the sidebar selector. Pure visual — no behavioral effect.
    color = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    # 多设备同步(方案A):增量 feed 的游标 + LWW 仲裁键。index 供 changes feed 范围扫
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


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

    # Pre-publish review queue. AI-generated images land here as `pending`;
    # operator approves or rejects via the 「审核」 module before they're
    # eligible for matching / cloud sync. Originals default to `approved`
    # to keep existing flows unchanged.
    #   pending  — awaiting operator decision
    #   approved — visible in matching, eligible for cloud sync
    #   rejected — hidden from matching, NOT pushed to cloud
    #   skipped  — operator chose to defer; same effect as pending for now
    review_status = Column(String, default="approved", index=True)
    reviewed_at = Column(DateTime)

    # 上下架(listing)— 与 review_status 正交的运营开关,决定是否参与 UGC 匹配。
    # 匹配候选池 = (review_status='approved') AND (is_listed=True)。
    #   - 存量图迁移置 True(保持现有可匹配行为,不回归)
    #   - OSS 反向导入的库外图显式置 False,必须运营「上架」后才进匹配
    #   - 「下架」可临时移出匹配池而不改审核状态(区别于 rejected)
    is_listed = Column(Boolean, default=True, index=True)
    listed_at = Column(DateTime)

    # 是否进「资产库」—— 与 review/listing 正交。AI 工坊生成图、拖到画布的本地图
    # 默认 in_library=False(只是画布草稿:本地存、画布可用、历史可追溯,但不进
    # 资产库列表、也不自动推 OSS)。运营点「加入资产库」后置 True → 进库 + 推 OSS
    # → 进而可审核/上架/参与 UGC。流水线扫描 / 资产库直接上传 的图默认 True。
    #   - 存量图迁移置 True(不回归)
    in_library = Column(Boolean, default=True, index=True)

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

    # Usage telemetry — incremented by /open-api/v1/images/{id}/track-usage
    # whenever a UGC client reports it actually displayed / chose this image.
    # Drives "素材使用热度" UI in the asset library and powers the future
    # freshness-decay heuristic (very stale + zero usage → demote in match).
    # NULL is intentionally allowed for old rows; treat as 0 in callers.
    usage_count = Column(Integer, default=0, server_default="0", nullable=False)
    last_used_at = Column(DateTime)

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

    # v0.3 创作画布 → 批量策略 桥接字段。
    # provenance = 'from_canvas' 时,UI 会在策略库列表显示「来自画布」标识;
    # canvas_snapshot 存当时画布上所有生成参数(model/ratio/style/strength/...),
    # 让"一键转批量"能无损还原。
    provenance = Column(String, default="manual", index=True)   # "manual" | "from_canvas"
    canvas_snapshot = Column(JSON)                              # 画布参数快照
    style_archive_id = Column(String, ForeignKey("style_archives.id"))
    speed = Column(String, default="refined")                   # "draft" | "refined"
    count_per_image = Column(Integer, default=1)


# ── StyleArchive (v0.3 风格档案 — 一致性) ──
#
# 一个风格档案 = 一组参考图 + 一致性强度,代表景区视觉风格(如「晨曦丁达尔」)。
# 用户在创作画布 / 批量策略里挑选一个 StyleArchive,后端在调底模时把 ref_image_ids
# 转成 sref/oref 参数,实现跨图风格一致。
class StyleArchive(Base):
    __tablename__ = "style_archives"

    id               = Column(String, primary_key=True, default=_uid)
    project_id       = Column(String, ForeignKey("projects.id"), index=True)
    name             = Column(String, nullable=False)
    description      = Column(Text, default="")
    ref_image_ids    = Column(JSON, default=list)              # [ImageRecord.id, ...]
    strength_default = Column(Float, default=0.7)
    params           = Column(JSON, default=dict)              # provider 特定参数
    created_at       = Column(DateTime, default=datetime.utcnow)
    updated_at       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
    # v0.2: ApiKey 归属一个组织。迁移时所有现有 ApiKey 归到 default-org。
    org_id = Column(String, ForeignKey("organizations.id"), index=True)
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


class SyncTombstone(Base):
    """删除墓碑 —— 多设备同步(方案A 云端权威)的删除事件载体。

    本地/云端硬删一行业务数据时,同时写一条墓碑(entity_type, entity_id,
    deleted_at)。增量 feed `GET /internal/sync/changes?since=` 从这里读出
    "since 之后被删了哪些 id",让其它设备 pull 时也能删掉本地对应行。

    为什么不用各表软删 deleted_at:那会牵动所有读查询 / 租户过滤 / 匹配
    候选池。墓碑表把"删除可追溯"这件事收敛到一张表,读路径零改动。

    幂等:同 (entity_type, entity_id) 反复删只更新 deleted_at(后写胜)。
    """
    __tablename__ = "sync_tombstones"

    id = Column(Integer, primary_key=True, autoincrement=True)
    entity_type = Column(String, nullable=False, index=True)  # 'image'|'project'|'api_key'|'user'|'org'|'org_member'|'project_member'
    entity_id = Column(String, nullable=False, index=True)
    deleted_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (
        UniqueConstraint("entity_type", "entity_id", name="uq_tombstone_entity"),
    )


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


class ConfigAuditLog(Base):
    """每次 config.json 写入留痕。
    用于回溯「什么时候、谁、把哪个 key 改成了什么」。
    新版本支持 user/ops 双发行版后特别重要 — 运营一旦多人协作，没审计就是
    last-write-wins 黑洞。
    """
    __tablename__ = "config_audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String, nullable=False, index=True)
    old_value = Column(JSON)             # 修改前；首次写入时为 null
    new_value = Column(JSON)             # 修改后；删除时为 null
    # 'desktop' = 用户在 桌面端 UI 点保存；'cloud_sync' = 云端 sidecar 收到
    # /internal/sync/config 的推送；'cli' = 后台 SQL/脚本直接改（手动迁移）
    source = Column(String, default="desktop", index=True)
    # 审计补充信息：machine hostname / build_flavor / process pid 等。
    # 没有强 schema — 看后续需要再固化。
    actor_meta = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


Index("idx_config_audit_key_time", ConfigAuditLog.key, ConfigAuditLog.created_at)


# ── User system + Organization (v0.2) ─────────────────────────────────────
#
# v0.1 引入了「身份 + 项目隔离」，v0.2 在它上面加了「组织（Organization）」
# 这一更高的层级，让客户公司之间彻底隔离 + 多设备同账号互通。
#
# 三层身份：
#   - Platform (`User.is_platform_owner=True`): 龙蟾科技超管，跨组织运维
#   - Organization: 客户公司；OrganizationMember.role ∈ owner/admin/member
#   - Project: 组织内的具体项目；ProjectMember.role ∈ project_admin/editor/viewer/labeler
#
# 兼容：现有 `User.is_root` 字段保留，迁移期与 is_platform_owner 同义；
# CLI bootstrap-root / reset-root 同时维护两边。
class Organization(Base):
    """客户公司空间。一个组织 = 一群人 + 一组项目 + 一份云端数据。"""
    __tablename__ = "organizations"

    id               = Column(String, primary_key=True, default=_uid)
    name             = Column(String, nullable=False)
    # URL 友好短名（lintu.app/o/{slug}），全平台唯一
    slug             = Column(String, unique=True, index=True, nullable=False)
    logo_url         = Column(String)
    contact_email    = Column(String)
    # free / pro / enterprise，影响 quota 上限
    plan             = Column(String, default="free", server_default="free")
    storage_quota_gb = Column(Integer, default=10, server_default="10")
    # 按需更新；后台脚本周期跑统计
    storage_used_gb  = Column(Float, default=0, server_default="0")
    # active | suspended | deleted（软删除 30 天可恢复）
    status           = Column(String, default="active", server_default="active", index=True)
    deleted_at       = Column(DateTime)
    created_at       = Column(DateTime, default=datetime.utcnow)
    updated_at       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class OrganizationMember(Base):
    """User × Organization 关联。一个用户可属多个组织（但每次会话只能 active 一个）。

    role:
      - owner   组织创建人，唯一且不可被踢；可改组织设置、删组织
      - admin   邀请人 / 管理项目 / 看用量；不能删组织
      - member  普通成员，项目权限取决于 ProjectMember
    """
    __tablename__ = "organization_members"

    id              = Column(String, primary_key=True, default=_uid)
    org_id          = Column(String, ForeignKey("organizations.id"), nullable=False, index=True)
    user_id         = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    role            = Column(String, default="member", server_default="member")
    invited_by      = Column(String, ForeignKey("users.id"))
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_org_member"),
    )


class User(Base):
    __tablename__ = "users"

    id                  = Column(String, primary_key=True, default=_uid)
    phone               = Column(String, unique=True, index=True, nullable=False)
    display_name        = Column(String)
    avatar_url          = Column(String)
    status              = Column(String, default="active", index=True)
    # v0.1 字段，保留兼容；v0.2 起优先看 is_platform_owner
    is_root             = Column(Boolean, default=False, server_default="0")
    # v0.2 新增：平台级超管（龙蟾科技超管）— 可跨组织运维 + 创建新组织
    is_platform_owner   = Column(Boolean, default=False, server_default="0", index=True)
    created_at          = Column(DateTime, default=datetime.utcnow)
    last_login_at       = Column(DateTime)
    updated_at          = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Session(Base):
    """一台设备一行；token 落 sha256，原始 token 丢给客户端存 safeStorage。
    可即时撤销（DELETE 或 revoked_at）；过期由 expires_at 控制。"""
    __tablename__ = "sessions"

    id              = Column(String, primary_key=True, default=_uid)
    user_id         = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    token_hash      = Column(String, nullable=False, unique=True, index=True)
    device_label    = Column(String)                            # "Mac mini-yang" / 浏览器 UA 摘要
    ip              = Column(String)
    user_agent      = Column(String)
    expires_at      = Column(DateTime, nullable=False, index=True)
    revoked_at      = Column(DateTime)
    created_at      = Column(DateTime, default=datetime.utcnow)


class ProjectMember(Base):
    """User × Project 关联。一个用户在一个项目里只有一行；用户必须先是
    OrganizationMember 才能加入该组织下的项目。

    role:
      - project_admin   项目最高权限：改设置 / 邀请成员 / 删除项目
      - editor          上传图、触发 AI 任务、删图、改 prompt 库内的"项目级"模板
      - viewer          只读
      - labeler         审核 + 打标，但不能上传/删图

    v0.1 历史值 'member' 在迁移时统一升为 'editor'（合理的中间态：能干活但
    不能管成员）。
    """
    __tablename__ = "project_members"

    id              = Column(String, primary_key=True, default=_uid)
    project_id      = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    user_id         = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    role            = Column(String, default="editor", server_default="editor")
    invited_by      = Column(String, ForeignKey("users.id"))
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)

    __table_args__ = (
        UniqueConstraint("project_id", "user_id", name="uq_project_member"),
    )


class SmsCode(Base):
    """短信验证码临时表。5 分钟过期，6 位数字，单手机号每分钟最多 1 条。"""
    __tablename__ = "sms_codes"

    id              = Column(String, primary_key=True, default=_uid)
    phone           = Column(String, nullable=False, index=True)
    code            = Column(String, nullable=False)            # 6 位明文（5 分钟过期不算严重风险）
    expires_at      = Column(DateTime, nullable=False, index=True)
    used            = Column(Boolean, default=False, server_default="0")
    attempts        = Column(Integer, default=0, server_default="0")  # 防爆破：同 code 输错 ≥3 次失效
    created_at      = Column(DateTime, default=datetime.utcnow, index=True)


class UserInvitation(Base):
    """管理员发邀请：phone + token_hash。被邀请人点链接 + 收码 → 接受。
    7 天过期；accepted_at 一旦填了就不能再用（一次性）。"""
    __tablename__ = "user_invitations"

    id              = Column(String, primary_key=True, default=_uid)
    project_id      = Column(String, ForeignKey("projects.id"), nullable=False, index=True)
    phone           = Column(String, nullable=False, index=True)
    role            = Column(String, default="member", server_default="member")
    token_hash      = Column(String, nullable=False, unique=True, index=True)
    invited_by      = Column(String, ForeignKey("users.id"))
    expires_at      = Column(DateTime, nullable=False, index=True)
    accepted_at     = Column(DateTime)
    created_at      = Column(DateTime, default=datetime.utcnow)


Index("idx_sessions_user_active", Session.user_id, Session.expires_at)
Index("idx_sms_codes_phone_time", SmsCode.phone, SmsCode.created_at)
Index("idx_invitations_project_phone", UserInvitation.project_id, UserInvitation.phone)


# ── Operation log ──────────────────────────────────────────────────────────
#
# 替代权限系统的"事前阻止" — Phase 1 不做角色拆分，但所有写操作必须留痕，
# 才能在「谁动了我的标签 / 提示词 / 配置」时回溯。
class OperationLog(Base):
    __tablename__ = "operation_logs"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    user_id     = Column(String, index=True)              # null = 未登录或 system root
    project_id  = Column(String, index=True)              # 仅租户级操作；全局表写入留 null
    method      = Column(String)                          # POST / PUT / PATCH / DELETE
    path        = Column(String, index=True)              # /api/images/{id}
    status_code = Column(Integer)
    summary     = Column(String)                          # 一句话描述（暂为 method+path）
    request_body_hash = Column(String)                    # sha256，便于排重不存原始
    ip          = Column(String)
    user_agent  = Column(String)
    created_at  = Column(DateTime, default=datetime.utcnow, index=True)


Index("idx_op_log_user_time", OperationLog.user_id, OperationLog.created_at)
Index("idx_op_log_path_time", OperationLog.path, OperationLog.created_at)
