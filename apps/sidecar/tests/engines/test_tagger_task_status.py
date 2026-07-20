"""AI 打标任务状态回归测试。

逐图 provider 失败必须进入 failed，并把失败数持久化；只有真正写入标签的
任务才能 completed。防止再次出现“0/64，却显示已完成”。
"""
from __future__ import annotations

import json

from sqlalchemy import func, select

from sidecar.db.models import Image, Tag, Task
from sidecar.engines import tagger
from sidecar.scheduler.engine import TaskScheduler


def _fake_setting(key: str):
    return {
        "tagger_max_concurrent": 2,
        "tagger_cost_limit_usd": 50.0,
        "tagger_retry_times": 1,
        "tagger_provider": "fake",
        "default_general_provider": "",
        "tagger_fallback_provider": "",
        "tagger_batch_size": 10,
    }.get(key)


class _FailingProvider:
    model = "fake-vision"

    async def tag_image(self, image_path: str, prompt: str):
        raise RuntimeError("provider rejected request")


class _SuccessProvider:
    model = "fake-vision"

    async def tag_image(self, image_path: str, prompt: str):
        return {
            "tags": {
                "scene": "山地景观",
                "season": "夏季",
                "weather": "晴天",
                "angle": "平拍",
                "people": "无人",
                "description": "画面：山景。氛围：晴朗。适合：景区宣传。",
            },
            "cost_usd": 0.01,
        }


async def _create_scoped_task(db_session, project_id: str) -> tuple[Task, Image]:
    image = Image(
        project_id=project_id,
        file_path="/tmp/fake-tag-image.jpg",
        file_name="fake-tag-image.jpg",
        quality_status="passed",
        is_kept=True,
        tag_status="pending",
    )
    db_session.add(image)
    await db_session.flush()

    task = Task(
        project_id=project_id,
        type="tag",
        status="queued",
        parameters=json.dumps({"image_ids": [image.id]}),
        total=1,
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)
    return task, image


async def test_all_image_failures_mark_task_failed(
    client, db_session, sample_project, monkeypatch,
):
    task, image = await _create_scoped_task(db_session, sample_project)
    monkeypatch.setattr(tagger, "get_setting", _fake_setting)
    monkeypatch.setattr(tagger, "_get_provider", lambda _name: _FailingProvider())

    scheduler = TaskScheduler()
    scheduler.register("tag", tagger.run_tagging)
    await scheduler._execute(task)

    await db_session.refresh(task)
    await db_session.refresh(image)
    assert task.status == "failed"
    assert task.total == 1
    assert task.processed == 1
    assert task.failed == 1
    assert "成功 0 张，失败 1 张" in (task.error_message or "")
    assert image.tag_status == "pending"


async def test_successful_tagging_is_the_only_completed_path(
    client, db_session, sample_project, monkeypatch,
):
    task, image = await _create_scoped_task(db_session, sample_project)
    monkeypatch.setattr(tagger, "get_setting", _fake_setting)
    monkeypatch.setattr(tagger, "_get_provider", lambda _name: _SuccessProvider())

    scheduler = TaskScheduler()
    scheduler.register("tag", tagger.run_tagging)
    await scheduler._execute(task)

    await db_session.refresh(task)
    await db_session.refresh(image)
    tag_count = await db_session.scalar(
        select(func.count(Tag.id)).where(Tag.image_id == image.id)
    )
    assert task.status == "completed"
    assert task.processed == 1
    assert task.failed == 0
    assert image.tag_status == "tagged"
    assert tag_count == 5


async def test_empty_candidate_set_does_not_complete(
    client, db_session, sample_project, monkeypatch,
):
    task = Task(
        project_id=sample_project,
        type="tag",
        status="queued",
        parameters="{}",
        total=0,
    )
    db_session.add(task)
    await db_session.commit()
    await db_session.refresh(task)
    monkeypatch.setattr(tagger, "get_setting", _fake_setting)
    # Provider resolution should not even run for an empty candidate set.
    monkeypatch.setattr(
        tagger,
        "_get_provider",
        lambda _name: (_ for _ in ()).throw(AssertionError("provider should not initialize")),
    )

    scheduler = TaskScheduler()
    scheduler.register("tag", tagger.run_tagging)
    await scheduler._execute(task)

    await db_session.refresh(task)
    assert task.status == "failed"
    assert task.processed == 0
    assert task.failed == 0
    assert "没有可打标的图片" in (task.error_message or "")
