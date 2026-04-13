from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sidecar.db.models import Image, Tag
from sidecar.db.session import get_db

router = APIRouter()

# Predefined tag values per dimension
TAG_VALUES = {
    "scene": ["山地景观", "水域", "森林步道", "游乐设施", "餐饮区", "住宿区", "入口大门", "停车场", "观景台", "商业街区", "室内场馆"],
    "season": ["春季", "夏季", "秋季", "冬季"],
    "weather": ["晴天", "多云", "阴天", "雨天", "雾天", "黄昏", "夜景"],
    "angle": ["俯拍", "仰拍", "平拍", "全景", "特写", "第一人称视角", "航拍"],
    "people": ["无人", "少量游客", "人群", "工作人员", "儿童", "吉祥物IP形象"],
}

SEASONS = {"春季", "夏季", "秋季", "冬季"}


@router.get("")
async def get_matrix(
    project_id: str = "",
    row: str = "season",
    col: str = "scene",
    db: AsyncSession = Depends(get_db),
):
    # Get images with both dimensions tagged
    query = (
        select(Image.id, Tag.dimension, Tag.value)
        .join(Tag, Tag.image_id == Image.id)
        .where(Image.quality_status == "passed")
        .where(Tag.dimension.in_([row, col]))
    )
    if project_id:
        query = query.where(Image.project_id == project_id)

    result = await db.execute(query)

    # Group tags by image
    image_tags: dict[str, dict] = defaultdict(lambda: {"row": set(), "col": set()})
    for image_id, dimension, value in result:
        if dimension == row:
            image_tags[image_id]["row"].add(value)
        elif dimension == col:
            image_tags[image_id]["col"].add(value)

    # Cross-tabulate
    matrix: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for tags in image_tags.values():
        for r in tags["row"]:
            for c in tags["col"]:
                matrix[r][c] += 1

    row_values = TAG_VALUES.get(row, sorted(set(r for tags in image_tags.values() for r in tags["row"])))
    col_values = TAG_VALUES.get(col, sorted(set(c for tags in image_tags.values() for c in tags["col"])))

    cells = []
    for r in row_values:
        for c in col_values:
            count = matrix[r][c]
            if count < 50:
                priority = "P0"
            elif count < 200:
                priority = "P1"
            else:
                priority = "P2"
            cells.append({"row": r, "col": c, "count": count, "priority": priority})

    p0_count = sum(1 for c in cells if c["priority"] == "P0")
    p1_count = sum(1 for c in cells if c["priority"] == "P1")

    # Top 5 suggestions
    p0_with_data = sorted(
        [c for c in cells if c["priority"] == "P0"],
        key=lambda c: c["count"],
    )
    suggestions = []
    for cell in p0_with_data[:5]:
        strategy = "seasonal" if cell["row"] in SEASONS or cell["col"] in SEASONS else "outpaint"
        suggestions.append({
            "gap": f"{cell['row']}×{cell['col']}",
            "current": cell["count"],
            "recommended_strategy": strategy,
            "description": f"当前仅{cell['count']}张，建议优先补足",
        })

    return {
        "row_dimension": row,
        "col_dimension": col,
        "row_values": row_values,
        "col_values": col_values,
        "cells": cells,
        "summary": {
            "total_cells": len(cells),
            "p0_gaps": p0_count,
            "p1_gaps": p1_count,
            "suggestions": suggestions,
        },
    }
