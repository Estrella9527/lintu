/**
 * 画布(Konva canvas)取主题色。
 *
 * 注意:Konva 把颜色字符串直接喂给 canvas 2d 的 strokeStyle/fillStyle,而
 * **canvas 不解析 CSS 变量**(`hsl(var(--accent))` 是无效色,会被忽略 → 落到
 * 默认黑)。所以这里读 `--accent-rgb`(一个 "r, g, b" 三元组)再拼成真实色串。
 *
 * 不长期缓存:深浅色切换时 --accent-rgb 会变;这些函数调用频率低(只在选中/
 * 关联线重渲时),getComputedStyle 开销可接受。
 */
function accentTriplet(): string {
  if (typeof window === 'undefined') return '124, 58, 237'
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()
  return v || '124, 58, 237'
}

/** 不透明 accent 色:rgb(r,g,b) */
export function accentColor(): string {
  return `rgb(${accentTriplet()})`
}

/** 带透明度的 accent 色:rgba(r,g,b,a) */
export function accentColorAlpha(alpha: number): string {
  return `rgba(${accentTriplet()}, ${alpha})`
}
