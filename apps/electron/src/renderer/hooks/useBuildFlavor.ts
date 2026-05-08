import { useEffect, useState } from 'react'

export type BuildFlavor = 'dev' | 'user' | 'ops'

/**
 * 读取 main 进程 baked 的 BUILD_FLAVOR：
 *   dev  开发模式（npm dev / npx electron .）
 *   user 普通分发版 — 物理屏蔽 cloud sync env vars
 *   ops  运营管理版 — 能改线上 UGC 配置
 *
 * Renderer 用它来：
 *   - SyncStatusBanner 决定是否要警告
 *   - 关于页 / 标题栏显示版本徽章
 *   - 试匹配等读相关页面对操作意图做防呆
 *
 * 兜底：取不到（旧版 preload / 老 main 进程）默认按 'user' 处理 — 保守。
 */
export function useBuildFlavor(): BuildFlavor {
  const [flavor, setFlavor] = useState<BuildFlavor>('user')
  useEffect(() => {
    const api = (window as any).updaterAPI
    if (!api?.getBuildFlavor) return
    api.getBuildFlavor()
      .then((f: BuildFlavor) => {
        if (f === 'dev' || f === 'user' || f === 'ops') setFlavor(f)
      })
      .catch(() => {/* keep default 'user' — safer */})
  }, [])
  return flavor
}
