import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { TaskProgressEvent } from '@/lib/types'

export function useTaskProgress(taskId: string | null) {
  const [progress, setProgress] = useState<TaskProgressEvent | null>(null)

  useEffect(() => {
    if (!taskId) {
      setProgress(null)
      return
    }

    const unsubscribe = api.tasks.subscribeProgress(taskId, (event) => {
      setProgress(event)
    })

    return unsubscribe
  }, [taskId])

  return progress
}
