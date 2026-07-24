"""Upload compression regressions.

New asset-library uploads must keep the pristine original, materialize a
separate publication derivative, and expose per-image failures instead of
letting the scheduler report a false completed task.
"""
from __future__ import annotations

import hashlib
import json

from PIL import Image as PILImage

from sidecar.db.models import Image, Task
from sidecar.engines.compress import run_compress
from sidecar.scheduler.engine import TaskScheduler


async def _run_compress_task(db_session, project_id: str, source_path: str):
    image = Image(
        project_id=project_id,
        file_path=source_path,
        file_name="upload-source.jpg",
        quality_status="passed",
        review_status="pending",
        compression_status="queued",
        compression_profile="jpeg-q80-2400-v1",
        in_library=True,
    )
    db_session.add(image)
    await db_session.flush()
    task = Task(
        project_id=project_id,
        type="compress",
        status="queued",
        parameters=json.dumps({
            "image_ids": [image.id],
            "quality": 80,
            "max_long_side": 2400,
            "profile": "jpeg-q80-2400-v1",
        }),
        total=1,
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)

    scheduler = TaskScheduler()
    scheduler.register("compress", run_compress)
    await scheduler._execute(task)
    await db_session.refresh(task)
    await db_session.refresh(image)
    return task, image


async def test_compress_keeps_original_and_creates_ready_derivative(
    client, db_session, sample_project, test_data_dir,
):
    source = test_data_dir / "compress-source.jpg"
    PILImage.new("RGB", (2600, 1800), (42, 120, 190)).save(source, quality=96)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    task, image = await _run_compress_task(db_session, sample_project, str(source))

    assert task.status == "completed"
    assert task.failed == 0
    assert image.compression_status == "ready"
    assert image.compression_error is None
    assert image.compressed_file_path
    assert image.compressed_size_kb is not None
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    derivative = test_data_dir / "workspace" / "derived" / "compress" / image.id[:2] / f"{image.id}.jpg"
    assert derivative.exists()
    assert image.compressed_file_path == str(derivative)


async def test_missing_source_marks_task_and_image_failed(
    client, db_session, sample_project, test_data_dir,
):
    missing = test_data_dir / "does-not-exist.jpg"
    task, image = await _run_compress_task(db_session, sample_project, str(missing))

    assert task.status == "failed"
    assert task.processed == 1
    assert task.failed == 1
    assert "1/1 张失败" in (task.error_message or "")
    assert image.compression_status == "failed"
    assert "file missing" in (image.compression_error or "")
    assert image.compressed_file_path is None
