import { useEffect, useState } from 'react'

import { releasesSince, type ReleaseEntry } from '@/data/release-notes'

const STORAGE_KEY = 'lintu_last_seen_version'

interface PromptState {
  /** 是否应该自动弹出 modal（仅升级或首装后才为 true） */
  open: boolean
  /** 待展示的版本列表（升级跨多版时，全部一次性展示） */
  releases: ReleaseEntry[]
  /** 用户关闭 modal — 把当前版本写入 storage 抑制下次弹出 */
  dismiss: () => void
}

/**
 * 升级 / 首装后首次启动自动弹出 release notes。
 *
 * 判定规则：
 *   - localStorage.lintu_last_seen_version === 当前版本  → 不弹（用户已看过）
 *   - 不等 / 没记录 → 弹出，列出比 lastSeen 更新的所有 release
 *
 * 全新安装首次启动也会弹一次（介绍当前版本能力）；用户点关闭后写入 storage 抑制。
 */
export function useReleaseNotesPrompt(currentVersion: string | undefined): PromptState {
  const [open, setOpen] = useState(false)
  const [releases, setReleases] = useState<ReleaseEntry[]>([])

  useEffect(() => {
    if (!currentVersion) return
    const lastSeen = (() => {
      try { return localStorage.getItem(STORAGE_KEY) } catch { return null }
    })()
    if (lastSeen === currentVersion) return  // 已看过，无事发生
    const pending = releasesSince(lastSeen)
    if (pending.length === 0) return  // 数据源为空 / 异常 → 不打扰
    setReleases(pending)
    setOpen(true)
  }, [currentVersion])

  function dismiss() {
    setOpen(false)
    if (currentVersion) {
      try { localStorage.setItem(STORAGE_KEY, currentVersion) } catch {}
    }
  }

  return { open, releases, dismiss }
}
