"""Strategy CRUD for AI Workshop — configuration-driven, not hardcoded."""

import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Strategy
from sidecar.db.session import get_db

router = APIRouter()

# Default built-in strategies (seeded on first load)
BUILTIN_STRATEGIES = [
    {"name": "画布扩展", "icon_keyword": "expand", "task_type": "outpaint", "sort_order": 1,
     "prompt": "将这张景区照片扩展为{ratio}比例。自然补全画面边缘内容，保持风格光线透视一致。照片级真实感。",
     "parameters": json.dumps([{"name": "ratio", "label": "目标比例", "type": "select", "options": ["16:9", "9:16", "4:3", "3:4", "1:1"], "default": "16:9"}])},
    {"name": "季节变换", "icon_keyword": "season", "task_type": "seasonal", "sort_order": 2,
     "prompt": "将这张景区风景照片变换为{season}场景。保持建筑道路设施等主体不变，只改变植被天空光线。照片级真实感。",
     "parameters": json.dumps([{"name": "season", "label": "目标季节", "type": "select", "options": ["春季", "夏季", "秋季", "冬季"], "default": "秋季"}])},
    {"name": "风格变换", "icon_keyword": "palette", "task_type": "style", "sort_order": 3,
     "prompt": "将这张照片转换为{style}艺术风格，保持构图。",
     "parameters": json.dumps([{"name": "style", "label": "风格", "type": "select", "options": ["水彩", "油画", "素描", "复古", "高对比", "柔焦"], "default": "水彩"}])},
    {"name": "局部编辑", "icon_keyword": "edit", "task_type": "inpaint", "sort_order": 4,
     "prompt": "{edit_prompt}",
     "parameters": json.dumps([{"name": "edit_type", "label": "编辑类型", "type": "select", "options": ["去水印", "去人物", "换天空", "去文字"], "default": "去水印"}])},
    {"name": "视角裁剪", "icon_keyword": "crop", "task_type": "crop", "sort_order": 5,
     "prompt": "",
     "parameters": json.dumps([{"name": "ratio", "label": "目标比例", "type": "select", "options": ["16:9", "9:16", "4:3", "3:4", "1:1"], "default": "16:9"}])},
    {"name": "超分增强", "icon_keyword": "upscale", "task_type": "upscale", "sort_order": 6,
     "prompt": "",
     "parameters": json.dumps([{"name": "scale", "label": "放大倍率", "type": "select", "options": ["2", "3", "4"], "default": "2"}])},
    {"name": "营销素材", "icon_keyword": "marketing", "task_type": "marketing", "sort_order": 7,
     "prompt": "",
     "parameters": json.dumps([
         {"name": "template", "label": "模板", "type": "select", "options": ["小红书封面", "朋友圈分享", "OTA详情页", "宣传海报"], "default": "小红书封面"},
         {"name": "text", "label": "文案", "type": "input", "placeholder": "叠加文案（可选）", "default": ""},
     ])},
]


async def seed_builtins(db: AsyncSession):
    """Insert built-in strategies if table is empty."""
    result = await db.execute(select(Strategy).limit(1))
    if result.scalar_one_or_none():
        return  # Already seeded
    for s in BUILTIN_STRATEGIES:
        db.add(Strategy(is_builtin=True, enabled=True, **s))
    await db.commit()


@router.get("")
async def list_strategies(db: AsyncSession = Depends(get_db)):
    await seed_builtins(db)
    result = await db.execute(select(Strategy).where(Strategy.enabled == True).order_by(Strategy.sort_order))
    return [_to_dict(s) for s in result.scalars().all()]


@router.get("/{strategy_id}")
async def get_strategy(strategy_id: str, db: AsyncSession = Depends(get_db)):
    s = await db.get(Strategy, strategy_id)
    if not s:
        raise HTTPException(404)
    return _to_dict(s)


class StrategyBody(BaseModel):
    name: str
    icon_keyword: str = ""
    task_type: str = "custom"
    prompt: str = ""
    parameters: str = "[]"
    sort_order: int = 99
    enabled: bool = True


@router.post("")
async def create_strategy(body: StrategyBody, db: AsyncSession = Depends(get_db)):
    s = Strategy(
        name=body.name, icon_keyword=body.icon_keyword, task_type=body.task_type,
        prompt=body.prompt, parameters=body.parameters,
        sort_order=body.sort_order, is_builtin=False, enabled=body.enabled,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _to_dict(s)


@router.put("/{strategy_id}")
async def update_strategy(strategy_id: str, body: StrategyBody, db: AsyncSession = Depends(get_db)):
    s = await db.get(Strategy, strategy_id)
    if not s:
        raise HTTPException(404)
    s.name = body.name
    s.icon_keyword = body.icon_keyword
    s.task_type = body.task_type
    s.prompt = body.prompt
    s.parameters = body.parameters
    s.sort_order = body.sort_order
    s.enabled = body.enabled
    await db.commit()
    return _to_dict(s)


@router.delete("/{strategy_id}")
async def delete_strategy(strategy_id: str, db: AsyncSession = Depends(get_db)):
    s = await db.get(Strategy, strategy_id)
    if not s:
        raise HTTPException(404)
    if s.is_builtin:
        s.enabled = False  # Don't delete builtins, just disable
        await db.commit()
        return {"ok": True, "action": "disabled"}
    await db.delete(s)
    await db.commit()
    return {"ok": True, "action": "deleted"}


def _to_dict(s: Strategy) -> dict:
    return {
        "id": s.id, "name": s.name, "icon_keyword": s.icon_keyword,
        "task_type": s.task_type, "prompt": s.prompt,
        "parameters": s.parameters, "sort_order": s.sort_order,
        "is_builtin": s.is_builtin, "enabled": s.enabled,
    }
