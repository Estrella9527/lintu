import { ImagePlus } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ImageDropOverlayProps {
  visible: boolean
  /** 自定义提示标题(默认:"松手即可上传到当前项目") */
  title?: string
  /** 自定义副标题 */
  subtitle?: string
  /** 半透明色调 — 资产库走 primary,seed 选择器可换 accent */
  tone?: 'primary' | 'accent'
}

/**
 * 拖拽进入时盖在宿主容器上的提示层。
 *
 * 视觉:整层弱化处理,贴合 lintu UI 的"少即是多":
 *   - 极淡的 tinted backdrop(不再用 bg-primary/8 这种偏浓的色)
 *   - 1px 虚线 border + 内层 6px 圆角容器,避免大色块
 *   - 图标在 rounded-square pill 里,跟其他模块的圆角按钮风格一致
 *   - 字号 13/11,strokeWidth 1.5,跟主导航 / Stat 一致
 *
 * pointerEvents=none 让 drop 事件能穿透到底层容器(由 useImageDropPaste 接)。
 */
export function ImageDropOverlay({
  visible,
  title = '松手上传到当前项目',
  subtitle = '支持 JPG / PNG / WebP / HEIC · 单文件 ≤ 50 MB',
  tone = 'primary',
}: ImageDropOverlayProps) {
  if (!visible) return null
  const toneText = tone === 'primary' ? 'text-primary' : 'text-accent'
  const toneBorder = tone === 'primary' ? 'border-primary/40' : 'border-accent/40'
  const toneBg = tone === 'primary' ? 'bg-primary/[0.06]' : 'bg-accent/[0.08]'
  const tonePill = tone === 'primary' ? 'bg-primary/12' : 'bg-accent/15'

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-50 p-3',
        'flex items-center justify-center',
      )}
    >
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2',
          'rounded-lg border border-dashed transition-colors',
          // 加强 backdrop-blur,把底下图片真的糊掉,文字才看得清。
          // bg-background/75 比 bg-primary/0.06 浓十几倍,提供足够对比度。
          'backdrop-blur-md bg-background/75',
          toneBorder,
        )}
      >
        <div
          className={cn(
            'inline-flex h-11 w-11 items-center justify-center rounded-xl',
            'ring-1 ring-foreground/5',
            tonePill,
          )}
        >
          <ImagePlus size={20} strokeWidth={1.5} className={toneText} />
        </div>
        <div className="text-[13.5px] font-semibold text-foreground/90">{title}</div>
        <div className="text-[11.5px] text-foreground/60">{subtitle}</div>
        <div className="sr-only">{toneBg}</div>
      </div>
    </div>
  )
}
