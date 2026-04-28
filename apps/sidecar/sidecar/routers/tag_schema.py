"""Tag schema management — defines dimensions and their allowed values."""

import json

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Dict, List

from sidecar.config import DATA_DIR
from sidecar.db.models import Tag
from sidecar.db.session import get_db

router = APIRouter()

SCHEMA_FILE = DATA_DIR / "tag_schema.json"

DEFAULT_SCHEMA: Dict[str, Dict] = {
    "scene": {
        "label": "场景类型",
        "required": True,
        "multi": False,
        "values": ["山地景观", "水域", "森林步道", "游乐设施", "餐饮区", "住宿区", "入口大门", "停车场", "观景台", "商业街区", "室内场馆"],
    },
    "facility": {
        "label": "项目设施",
        "required": False,
        "multi": True,
        "values": [
            "玻璃滑道", "高空吊桥", "卡丁车", "彩虹赛道", "漂流", "攀岩墙", "蹦极", "滑索",
            "旱雪滑道", "蹦蹦云", "网红秋千", "丛林穿越", "水上乐园", "露营基地", "坚果乐园",
            "亲子乐园", "玻璃观景台", "丛林飞渡", "悬崖过山车", "蒙奇穿越", "路极飞车",
            "飞索环游", "象鼻滑滑乐", "森林骑士", "小鹿上山", "滑出边际",
        ],
    },
    "season": {
        "label": "季节",
        "required": True,
        "multi": False,
        "values": ["春季", "夏季", "秋季", "冬季"],
    },
    "weather": {
        "label": "天气光线",
        "required": True,
        "multi": False,
        "values": ["晴天", "多云", "阴天", "雨天", "雾天", "黄昏", "夜景"],
    },
    "angle": {
        "label": "视角",
        "required": True,
        "multi": False,
        "values": ["俯拍", "仰拍", "平拍", "全景", "特写", "第一人称视角", "航拍"],
    },
    "people": {
        "label": "人物",
        "required": True,
        "multi": False,
        "values": ["无人", "少量游客", "人群", "工作人员", "儿童", "吉祥物IP形象"],
    },
    "usage": {
        "label": "画面用途",
        "required": False,
        "multi": True,
        "values": ["小红书封面", "朋友圈分享", "OTA详情页", "宣传海报底图", "景区导览", "不适合外发"],
    },

    # ── 语义增强维度（S5.3 软标签层）──
    # 这些维度对"风格化生图"和"情感/氛围词"匹配尤其关键。原有 7 维（场景/季节
    # 等）只能描述「客观内容」；下面 5 维描述「主观感受 + 视觉风格」，弥补
    # 文图匹配在抽象语义上的缺口（如「温馨亲子时光」「敦煌风情」「赛博朋克」）。
    "style": {
        "label": "视觉风格",
        "required": False,
        "multi": True,
        "values": [
            "写实摄影", "胶片质感", "电影感", "纪实风", "高清航拍",
            "中国画", "水墨", "工笔", "敦煌壁画", "国风", "古风",
            "油画", "印象派", "水彩", "素描", "手绘插画", "动漫风", "卡通",
            "像素艺术", "赛博朋克", "蒸汽朋克", "未来科技",
            "极简主义", "复古胶卷", "黑白", "日系小清新", "ins 风", "新中式",
        ],
    },
    "mood": {
        "label": "情绪氛围",
        "required": False,
        "multi": True,
        "values": [
            "温馨", "治愈", "浪漫", "幸福", "欢乐", "热闹", "梦幻", "唯美",
            "震撼", "壮观", "神圣", "庄严", "肃穆",
            "静谧", "宁静", "禅意", "空灵", "孤独", "苍凉", "怀旧",
            "神秘", "诡异", "紧张", "刺激", "肾上腺素", "炫酷", "活力",
        ],
    },
    "palette": {
        "label": "色彩调性",
        "required": False,
        "multi": True,
        "values": [
            "暖色调", "冷色调", "中性色调", "莫兰迪", "高饱和", "低饱和",
            "高对比", "低对比", "黑白", "单色", "互补色", "邻近色",
            "金色", "蓝调", "绿调", "粉色系", "大地色系", "莫奈色",
        ],
    },
    "theme": {
        "label": "适用主题",
        "required": False,
        "multi": True,
        "values": [
            "亲子时光", "情侣约会", "闺蜜出游", "家庭聚会", "团建活动",
            "毕业纪念", "婚纱外景", "宝宝写真", "网红打卡", "摄影采风",
            "户外探险", "度假休闲", "节庆活动", "文化研学", "商务接待",
        ],
    },
    "composition": {
        "label": "构图技法",
        "required": False,
        "multi": True,
        "values": [
            "中心对称", "三分法", "对角线构图", "引导线", "框架式构图",
            "前景遮挡", "纵深感", "极简留白", "满屏铺满", "重复韵律",
            "黄金分割", "对比构图", "几何构图",
        ],
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


@router.get("/usage")
async def tag_value_usage(db: AsyncSession = Depends(get_db)):
    """Per-(dimension, value) hit counts across all images. Powers the
    "标签命中数" badges in the schema editor — surfaces dead values that
    AI never assigns and overweighted ones that need splitting."""
    rows = (await db.execute(
        select(Tag.dimension, Tag.value, func.count(Tag.id))
        .group_by(Tag.dimension, Tag.value)
    )).all()
    out: Dict[str, Dict[str, int]] = {}
    for dim, val, n in rows:
        if not dim or not val:
            continue
        out.setdefault(dim, {})[val] = int(n or 0)
    return out


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
