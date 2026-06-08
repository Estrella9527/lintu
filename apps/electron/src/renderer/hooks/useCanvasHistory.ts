import { useCallback, useEffect, useRef } from 'react'
import { useAtom } from 'jotai'

import { canvasObjectsAtom, type CanvasObject } from '@/atoms/canvas'

/**
 * Undo/redo 栈 — 只栈对象列表的快照,不存像素 / viewport。
 *
 * 设计取舍:
 *   - **只存对象 transform**(x/y/width/height/rotation/id),不存 viewport
 *     (用户撤销不应该让画布"穿越"到之前的视角,反而很迷惑)
 *   - 用浅拷贝 list + 对象本身浅拷贝;Phase 1 没复杂嵌套结构,够用
 *   - 上限 100 条,超出丢最早的 — 内存友好
 *   - **每次对象数组发生引用变化时 push 一条**;UI 的高频 onMove 必须节流
 *     调用方,不然移动一像素就一条 history。
 *   - Ctrl/Cmd Z / Shift+Z 已在 hook 内挂全局 keyboard listener,组件不需要
 *     再绑定 — Phase 1 唯一的画布页面挂一次就够
 *
 * 调用方:
 *   const { undo, redo, push, canUndo, canRedo } = useCanvasHistory()
 *   push() 会在每次"明确的用户动作完成"时手动触发,比如 onMoveEnd / onAddImage。
 */
interface UseCanvasHistoryReturn {
  push: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

const MAX_HISTORY = 100

export function useCanvasHistory(): UseCanvasHistoryReturn {
  const [objects, setObjects] = useAtom(canvasObjectsAtom)
  // past / future 用 ref,避免 push 触发 React 重渲染
  const pastRef = useRef<CanvasObject[][]>([])
  const futureRef = useRef<CanvasObject[][]>([])

  const snap = useCallback(() => objects.map((o) => ({ ...o })), [objects])

  const push = useCallback(() => {
    const snapshot = snap()
    pastRef.current.push(snapshot)
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift()
    futureRef.current = []  // 新动作打断 redo 链
  }, [snap])

  const undo = useCallback(() => {
    const prev = pastRef.current.pop()
    if (!prev) return
    futureRef.current.push(snap())
    setObjects(prev)
  }, [snap, setObjects])

  const redo = useCallback(() => {
    const next = futureRef.current.pop()
    if (!next) return
    pastRef.current.push(snap())
    setObjects(next)
  }, [snap, setObjects])

  // 全局 ⌘Z / ⌘⇧Z 监听 — Phase 1 画布是唯一 host
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'z') return
      // 输入框焦点时让原生 undo 优先(注意:contentEditable / canvas 不算)
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return {
    push, undo, redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
  }
}
