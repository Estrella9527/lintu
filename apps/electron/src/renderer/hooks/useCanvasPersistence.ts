import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'

import { activeProjectIdAtom } from '@/atoms/project'
import {
  canvasObjectsAtom,
  canvasParamsAtom,
  canvasSnapshotsAtom,
  canvasViewportAtom,
  promptBarPromptAtom,
  promptBarRefsAtom,
  selectedObjectIdAtom,
  type PersistedCanvas,
} from '@/atoms/canvas'
import { api } from '@/lib/api'

const SAVE_DEBOUNCE_MS = 500

/**
 * 画布持久化 — 切项目恢复对应快照,内存 atoms 变化时防抖回写。
 *
 * 设计:
 *   - 「已加载哪个项目」用 ref 标记;每次切项目都清一遍内存 atoms 然后从 snapshot 灌
 *   - 同一项目内的任何变化 → 防抖 500ms 合成一次写入(避免拖拽时高频 JSON 序列化)
 *   - 持久化时 objects.src 被 strip(根据 image_id 可还原),减小存储体积 + 避免 token 变化引起的过期问题
 *   - 返回 { lastSavedAt, clearCanvas } 给 Toolbar 显示状态 + 主动清空
 */
export interface UseCanvasPersistenceReturn {
  lastSavedAt: Date | null
  clearCanvas: () => void
}

export function useCanvasPersistence(): UseCanvasPersistenceReturn {
  const projectId = useAtomValue(activeProjectIdAtom)
  const [snapshots, setSnapshots] = useAtom(canvasSnapshotsAtom)
  const [objects, setObjects] = useAtom(canvasObjectsAtom)
  const [viewport, setViewport] = useAtom(canvasViewportAtom)
  const [params, setParams] = useAtom(canvasParamsAtom)
  const [refs, setRefs] = useAtom(promptBarRefsAtom)
  const [prompt, setPrompt] = useAtom(promptBarPromptAtom)
  const setSelectedId = useAtom(selectedObjectIdAtom)[1]
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)

  // 记录"内存 atoms 已经为哪个 project 灌过了"。
  // 切项目时不 match 当前 projectId → 触发加载并跳过本次 save effect(因为 save effect
  // 会因为 setObjects 触发而被调用,我们不想在加载时立刻覆盖快照本身)
  const loadedForProjectRef = useRef<string | null>(null)

  // ── 加载 ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) {
      // 没选项目时清空,避免上一个项目的对象残留
      loadedForProjectRef.current = null
      setObjects([]); setViewport({ scale: 1, x: 0, y: 0 })
      setRefs([]); setPrompt('')
      setSelectedId(null)
      return
    }
    if (loadedForProjectRef.current === projectId) return

    loadedForProjectRef.current = projectId
    const snap = snapshots[projectId]
    if (snap) {
      // 还原 objects:image 重新生成带 token 的 src;placeholder 如果还是 pending,
      // 转成 error(任务已被 app 重启打断,不可能完成),让用户看见状态并自行删除/重试
      setObjects((snap.objects || []).map((o) => {
        if ((o as any).type === 'placeholder') {
          const p = o as any
          return p.status === 'pending'
            ? { ...p, status: 'error', errorMessage: '任务被 app 重启打断,无法继续' }
            : p
        }
        return { ...o, src: api.images.fileUrl((o as any).image_id) }
      }))
      setViewport(snap.viewport || { scale: 1, x: 0, y: 0 })
      if (snap.params) setParams(snap.params)
      setRefs(snap.refs || [])
      setPrompt(snap.prompt || '')
      setSelectedId(null)
      setLastSavedAt(snap.updated_at ? new Date(snap.updated_at) : null)
    } else {
      setObjects([]); setViewport({ scale: 1, x: 0, y: 0 })
      setRefs([]); setPrompt('')
      setSelectedId(null)
      setLastSavedAt(null)
    }
    // 故意不把 snapshots 进 deps:它本身在我们 save 时也会变,会引起循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // ── 保存 ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId || loadedForProjectRef.current !== projectId) return
    const timer = setTimeout(() => {
      // 注意:objects 序列化前 strip src(image 才有 src;placeholder 没这字段)
      const stripped = objects.map((o) => (
        (o as any).type === 'placeholder' ? o : { ...o, src: '' }
      ))
      const next: PersistedCanvas = {
        objects: stripped,
        viewport,
        params,
        refs,
        prompt,
        updated_at: new Date().toISOString(),
      }
      setSnapshots((prev) => {
        // 防丢护栏:内存里是「空画布」但存档里「有内容」时,绝不覆盖。
        // 这种"空"通常是瞬态的 —— 代码热更新 / 模块重载会把 jotai atom 重置成
        // 默认空值,若此刻 debounce 保存就会把真实存档冲掉(本次事故根因)。
        // 真正想清空画布请走「清空画布」按钮(clearCanvas,显式删除 entry)。
        const prevObjs = prev[projectId]?.objects?.length ?? 0
        if (stripped.length === 0 && prevObjs > 0) {
          return prev
        }
        return { ...prev, [projectId]: next }
      })
      setLastSavedAt(new Date())
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [projectId, objects, viewport, params, refs, prompt, setSnapshots])

  // ── 主动清空 — Toolbar 「新建画布」按钮调 ─────────────────────────────
  const clearCanvas = () => {
    if (!projectId) return
    setObjects([]); setViewport({ scale: 1, x: 0, y: 0 })
    setRefs([]); setPrompt('')
    setSelectedId(null)
    setSnapshots((prev) => {
      const next = { ...prev }
      delete next[projectId]
      return next
    })
    setLastSavedAt(null)
  }

  return { lastSavedAt, clearCanvas }
}
