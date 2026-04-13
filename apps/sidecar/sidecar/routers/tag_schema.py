"""Tag schema management — defines dimensions and their allowed values."""

import json

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Dict, List

from sidecar.config import DATA_DIR

router = APIRouter()

SCHEMA_FILE = DATA_DIR / "tag_schema.json"

DEFAULT_SCHEMA: Dict[str, Dict] = {
    "scene": {
        "label": "场景",
        "values": ["山地景观", "水域", "森林步道", "游乐设施", "餐饮区", "住宿区", "入口大门", "停车场", "观景台", "商业街区", "室内场馆"],
    },
    "facility": {
        "label": "设施",
        "values": ["索道", "栈道", "观光车", "游船", "滑道", "缆车", "儿童乐园", "餐厅", "商店", "洗手间"],
        "multi": True,
    },
    "season": {
        "label": "季节",
        "values": ["春季", "夏季", "秋季", "冬季"],
    },
    "weather": {
        "label": "天气",
        "values": ["晴天", "多云", "阴天", "雨天", "雾天", "黄昏", "夜景"],
    },
    "angle": {
        "label": "角度",
        "values": ["俯拍", "仰拍", "平拍", "全景", "特写", "第一人称视角", "航拍"],
    },
    "people": {
        "label": "人物",
        "values": ["无人", "少量游客", "人群", "工作人员", "儿童", "吉祥物IP形象"],
    },
    "usage": {
        "label": "用途",
        "values": ["小红书封面", "朋友圈分享", "OTA详情页", "宣传海报底图", "景区导览", "不适合外发"],
        "multi": True,
    },
}


def _read_schema() -> dict:
    if SCHEMA_FILE.exists():
        return json.loads(SCHEMA_FILE.read_text())
    return DEFAULT_SCHEMA


def _write_schema(data: dict):
    SCHEMA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def get_tag_values(dimension: str) -> list:
    """Get allowed values for a dimension. Used by matrix router."""
    schema = _read_schema()
    dim = schema.get(dimension, {})
    return dim.get("values", [])


@router.get("")
async def get_tag_schema():
    return _read_schema()


class UpdateDimensionBody(BaseModel):
    label: str
    values: List[str]
    multi: bool = False


@router.put("/{dimension}")
async def update_dimension(dimension: str, body: UpdateDimensionBody):
    schema = _read_schema()
    schema[dimension] = {"label": body.label, "values": body.values}
    if body.multi:
        schema[dimension]["multi"] = True
    _write_schema(schema)
    return {"ok": True}


@router.delete("/{dimension}/{value}")
async def remove_value(dimension: str, value: str):
    schema = _read_schema()
    if dimension in schema:
        values = schema[dimension].get("values", [])
        schema[dimension]["values"] = [v for v in values if v != value]
        _write_schema(schema)
    return {"ok": True}


class AddValueBody(BaseModel):
    value: str


@router.post("/{dimension}/values")
async def add_value(dimension: str, body: AddValueBody):
    schema = _read_schema()
    if dimension not in schema:
        return {"ok": False, "error": "维度不存在"}
    values = schema[dimension].get("values", [])
    if body.value not in values:
        values.append(body.value)
        schema[dimension]["values"] = values
        _write_schema(schema)
    return {"ok": True}
