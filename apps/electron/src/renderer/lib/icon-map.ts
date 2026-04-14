/**
 * Icon auto-matching: maps keywords in strategy names to Lucide icon names.
 * When a user creates a custom strategy, the icon is inferred from the name.
 * Matching priority: icon_keyword field > name substring match > default.
 */
import {
  Maximize, Leaf, Palette, Scissors, Eye, Zap, Megaphone,
  Wand2, Sun, Moon, Snowflake, Cloud, Camera, Image,
  Sparkles, PaintBucket, Eraser, Frame, Crop, Move,
  Type, Layers, RefreshCw, Brush, Aperture, Focus,
  Mountain, TreePine, Building, Droplets, Wind,
  type LucideIcon,
} from 'lucide-react'

const KEYWORD_MAP: Record<string, LucideIcon> = {
  // Strategy types
  expand: Maximize,
  outpaint: Maximize,
  扩展: Maximize,
  扩图: Maximize,

  season: Leaf,
  seasonal: Leaf,
  季节: Leaf,
  春: Leaf,
  夏: Sun,
  秋: Leaf,
  冬: Snowflake,

  palette: Palette,
  style: Palette,
  风格: Palette,
  艺术: Brush,
  水彩: Droplets,
  油画: PaintBucket,

  edit: Scissors,
  inpaint: Scissors,
  编辑: Scissors,
  修复: Eraser,
  去除: Eraser,
  去水印: Eraser,

  crop: Eye,
  裁剪: Crop,
  视角: Eye,

  upscale: Zap,
  超分: Zap,
  增强: Zap,
  高清: Zap,

  marketing: Megaphone,
  营销: Megaphone,
  素材: Megaphone,
  海报: Frame,
  封面: Image,

  // Nature / scene
  山: Mountain,
  森林: TreePine,
  建筑: Building,
  水: Droplets,
  天气: Cloud,
  天空: Cloud,
  雪: Snowflake,
  风: Wind,

  // General
  custom: Wand2,
  自定义: Wand2,
  生成: Sparkles,
  变换: RefreshCw,
  滤镜: Aperture,
  光影: Focus,
  文字: Type,
  叠加: Layers,
  拍摄: Camera,
}

export function matchIcon(iconKeyword: string, name: string): LucideIcon {
  // 1. Exact keyword match
  if (iconKeyword && KEYWORD_MAP[iconKeyword]) {
    return KEYWORD_MAP[iconKeyword]
  }

  // 2. Name substring match (check longer keywords first)
  const sortedKeys = Object.keys(KEYWORD_MAP).sort((a, b) => b.length - a.length)
  for (const key of sortedKeys) {
    if (name.includes(key)) {
      return KEYWORD_MAP[key]
    }
  }

  // 3. Default
  return Wand2
}
