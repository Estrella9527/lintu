"""Asset-library direct upload and compression-publish semantics."""
from __future__ import annotations

import io

from PIL import Image as PILImage
from sqlalchemy import select
from sidecar.db.models import Image, OssSyncJob, Task
from sidecar.engines import oss_sync


def _jpeg_bytes() -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (640, 480), (80, 150, 60)).save(buf, "JPEG", quality=95)
    return buf.getvalue()


class _ConfiguredStorage:
    def is_configured(self) -> bool:
        return True


async def test_gallery_upload_saves_original_and_queues_direct_publication(
    client, db_session, sample_project,
):
    uploaded = client.post(
        "/api/images/upload",
        data={"project_id": sample_project, "in_library": "true"},
        files={"files": ("camera.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 200, uploaded.text
    body = uploaded.json()
    assert body["uploaded"] == 1
    assert body["compression_task_id"]
    image_id = body["images"][0]["id"]

    image = await db_session.get(Image, image_id)
    task = await db_session.get(Task, body["compression_task_id"])
    assert image is not None
    assert task is not None
    assert task.type == "compress"
    assert image.compression_status in {"queued", "running", "ready"}
    assert image.file_path.endswith(".jpg")
    assert image.in_library is True
    # 用户确认上传图库就是发布授权，不再停在 local/pending 审核态。
    assert image.review_status == "approved"
    assert image.upload_batch_id is None


async def test_gallery_upload_promotes_existing_local_duplicate(
    client, db_session, sample_project,
):
    """历史本地草稿被再次明确上传时，也必须进入自动发布链路。"""
    image_bytes = _jpeg_bytes()
    staged = client.post(
        "/api/images/upload",
        data={"project_id": sample_project, "in_library": "false"},
        files={"files": ("camera.jpg", image_bytes, "image/jpeg")},
    )
    assert staged.status_code == 200, staged.text
    image_id = staged.json()["images"][0]["id"]
    image = await db_session.get(Image, image_id)
    assert image is not None
    assert image.review_status == "local"
    assert image.compression_status is None

    published = client.post(
        "/api/images/upload",
        data={"project_id": sample_project, "in_library": "true"},
        files={"files": ("camera.jpg", image_bytes, "image/jpeg")},
    )
    assert published.status_code == 200, published.text
    body = published.json()
    assert body["uploaded"] == 0
    assert body["skipped_duplicates"] == 1
    assert body["compression_task_id"]

    await db_session.refresh(image)
    assert image.in_library is True
    assert image.review_status == "approved"
    assert image.compression_status in {"queued", "running", "ready"}


async def test_publish_endpoint_promotes_selected_local_draft(
    client, db_session, sample_project,
):
    """画布/旧版本地草稿可在不重选文件的前提下明确上传到图库。"""
    staged = client.post(
        "/api/images/upload",
        data={"project_id": sample_project, "in_library": "false"},
        files={"files": ("canvas.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert staged.status_code == 200, staged.text
    image_id = staged.json()["images"][0]["id"]

    published = client.post("/api/images/publish", json={"image_ids": [image_id]})
    assert published.status_code == 200, published.text
    body = published.json()
    assert body["ok"] is True
    assert body["requested"] == 1
    assert body["published"] == 1
    assert body["compression_task_id"]

    image = await db_session.get(Image, image_id)
    assert image is not None
    assert image.in_library is True
    assert image.review_status == "approved"
    assert image.compression_status in {"queued", "running", "ready"}


async def test_gallery_asset_can_enter_oss_queue_before_tags_exist(
    client, db_session, sample_project, monkeypatch,
):
    """打标是检索增强，不再阻塞用户已确认上传图库的 OSS 同步。"""
    uploaded = client.post(
        "/api/images/upload",
        data={"project_id": sample_project, "in_library": "true"},
        files={"files": ("camera.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert uploaded.status_code == 200, uploaded.text
    image_id = uploaded.json()["images"][0]["id"]
    image = await db_session.get(Image, image_id)
    assert image is not None
    # 该测试只验证标签门禁已移除；压缩门禁由独立回归覆盖。
    image.compression_status = None
    await db_session.commit()

    monkeypatch.setattr(oss_sync, "get_storage", lambda: _ConfiguredStorage())
    assert await oss_sync.enqueue_image_sync(image_id) == 3

    jobs = (await db_session.execute(
        select(OssSyncJob).where(OssSyncJob.image_id == image_id)
    )).scalars().all()
    assert {job.asset_kind for job in jobs} == {"original", "thumb_300", "thumb_800"}
