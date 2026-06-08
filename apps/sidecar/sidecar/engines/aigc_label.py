"""AI 生成内容标识(合规)。

依据《人工智能生成合成内容标识办法》(2025 起施行),AI 生成的图片需要带
**隐式标识**(写进文件元数据/数字水印),通过公开渠道分发时还应有显式标识。

本模块负责"隐式标识"这一层:在 PNG 元数据(tEXt chunk)里写入标准化的
AIGC 字段。字段命名贴近 IPTC / C2PA 的惯例,便于后续接入正规 C2PA 签名:

  - `AIGC`            : "true"(机器可读的总开关)
  - `DigitalSourceType`: 取 IPTC 词表 trainedAlgorithmicMedia
  - `Generator`       : 生产平台 + 操作类型
  - `GenerationTime`  : ISO 时间

显式标识(画面角标/分发出口水印)是分发中心侧的后续工作,这里先把每张产物的
隐式标识做扎实 —— 它跟着文件走,即使被转存也还在。
"""
from __future__ import annotations

import io
import logging
from datetime import datetime

from PIL import Image as PILImage
from PIL import PngImagePlugin

logger = logging.getLogger(__name__)

# IPTC Digital Source Type 词表:纯 AI 生成
_DIGITAL_SOURCE_TYPE = "trainedAlgorithmicMedia"
_GENERATOR = "Lintu AIGC"


def embed_aigc_label_png(image_bytes: bytes, *, gtype: str, model: str | None = None) -> bytes:
    """把 AIGC 隐式标识写进 PNG 元数据,返回新的 PNG 字节。

    失败时返回原始字节(标识是合规增强,不能因为它让生成整体失败)。
    """
    try:
        with PILImage.open(io.BytesIO(image_bytes)) as im:
            im.load()
            meta = PngImagePlugin.PngInfo()
            meta.add_text("AIGC", "true")
            meta.add_text("DigitalSourceType", _DIGITAL_SOURCE_TYPE)
            gen = f"{_GENERATOR} ({gtype})" + (f" via {model}" if model else "")
            meta.add_text("Generator", gen)
            meta.add_text("GenerationTime", datetime.utcnow().isoformat() + "Z")
            out = io.BytesIO()
            # 统一转 RGBA→以 PNG 存(provider 多数本就返回 PNG);保留 alpha。
            save_im = im if im.mode in ("RGB", "RGBA", "L", "LA", "P") else im.convert("RGBA")
            save_im.save(out, format="PNG", pnginfo=meta, optimize=False)
            return out.getvalue()
    except Exception as e:
        logger.warning("写入 AIGC 标识失败,使用原始字节: %s", e)
        return image_bytes


def read_aigc_label(path: str) -> dict | None:
    """读取 PNG 里的 AIGC 标识(供审计/校验用)。无则返回 None。"""
    try:
        with PILImage.open(path) as im:
            info = getattr(im, "text", {}) or {}
            if info.get("AIGC") == "true":
                return {k: info.get(k) for k in
                        ("AIGC", "DigitalSourceType", "Generator", "GenerationTime")}
    except Exception:
        pass
    return None
