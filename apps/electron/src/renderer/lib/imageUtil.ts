/**
 * 把用户选的本地图片文件缩到 256×256（中心裁剪）+ JPEG 压缩 → base64 data URL。
 *
 * 头像场景需要小、统一尺寸：
 *   - 256×256 是头像主流尺寸（够清晰，DB 写入 ~30-60KB）
 *   - JPEG 0.85 质量比 PNG 小 5-10 倍
 *   - 中心裁剪而不是 fit，避免横长头像两边留黑边
 *
 * 返回 data URL 直接写进 user.avatar_url；前端 <img src> 原生支持。
 */
export async function fileToAvatarDataUrl(file: File, size = 256): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件')
  }
  // 客户端先做 5MB 上限，更大的图通常是误选
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('图片不能大于 5 MB')
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('图片解码失败'))
    i.src = dataUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')

  // 中心裁剪到正方形
  const srcSize = Math.min(img.width, img.height)
  const sx = (img.width - srcSize) / 2
  const sy = (img.height - srcSize) / 2
  ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, size, size)

  // PNG 透明通道丢失没关系 — 头像不需要透明背景，统一 JPEG 压缩
  return canvas.toDataURL('image/jpeg', 0.85)
}
