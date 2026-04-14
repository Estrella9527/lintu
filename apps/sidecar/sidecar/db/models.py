import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
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
