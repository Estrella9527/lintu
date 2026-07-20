import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { TaskProgressEvent } from '@/lib/types'

/**
 * Subscribes to a task's SSE progress stream.
 *
 * Monotonic guard: SSE events arrive per-image and the server polls task
 * rows every 3s. Without this guard, a stale SSE event (e.g. processed=22)
 * could overwrite a fresher DB update (processed=25) and make the bar
 * regress visually. We keep the maximum-seen `processed` and merge the
 * latest event's other fields on top.
 */
export function useTaskProgress(taskId: string | null) {
  const [progress, setProgress] = useState<TaskProgressEvent | null>(null)

  useEffect(() => {
    if (!taskId) {
      setProgress(null)
      return
    }

    const unsubscribe = api.tasks.subscribeProgress(taskId, (event) => {
      setProgress((cur) => {
        if (!cur) return event
        const merged: TaskProgressEvent = { ...cur, ...event }
        if (cur.processed != null && event.processed != null) {
          merged.processed = Math.max(cur.processed, event.processed)
        }
        if (cur.total != null && event.total != null) {
          merged.total = Math.max(cur.total, event.total)
        }
        if (cur.failed != null && event.failed != null) {
          merged.failed = Math.max(cur.failed, event.failed)
        }
        return merged
      })
    })

    return unsubscribe
  }, [taskId])

  return progress
}
