import type {
  TaskRecord,
  ImageRecord,
  DashboardStats,
  CoverageMatrix,
  TaskProgressEvent,
} from './types'

const API_BASE = 'http://localhost:7879/api'

class APIClient {
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      ...init,
    })
    if (!res.ok) {
      throw new Error(`API Error ${res.status}: ${await res.text()}`)
    }
    return res.json()
  }

  // ── Tasks ──

  tasks = {
    create: (type: string, params: Record<string, unknown>) => {
      const { project_id, ...rest } = params
      return this.request<{ task_id: string }>('/tasks', {
        method: 'POST',
        body: JSON.stringify({ type, project_id, parameters: rest }),
      })
    },

    list: (filter?: Record<string, string>) => {
      const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
      return this.request<TaskRecord[]>(`/tasks${qs}`)
    },

    get: (id: string) => this.request<TaskRecord>(`/tasks/${id}`),

    pause: (id: string) =>
      this.request(`/tasks/${id}/pause`, { method: 'POST' }),

    resume: (id: string) =>
      this.request(`/tasks/${id}/resume`, { method: 'POST' }),

    cancel: (id: string) =>
      this.request(`/tasks/${id}/cancel`, { method: 'POST' }),

    subscribeProgress(
      id: string,
      onMessage: (event: TaskProgressEvent) => void,
    ): () => void {
      const es = new EventSource(`${API_BASE}/tasks/${id}/stream`)
      es.onmessage = (e) => onMessage(JSON.parse(e.data))
      es.onerror = () => {
        // Auto-reconnect is built into EventSource
      }
      return () => es.close()
    },
  }

  // ── Images ──

  images = {
    list: (params: {
      project_id: string
      offset?: number
      limit?: number
      search?: string
      status?: string
      scene?: string[]
      season?: string[]
      weather?: string[]
    }) => {
      const qs = new URLSearchParams()
      qs.set('project_id', params.project_id)
      if (params.offset !== undefined) qs.set('offset', String(params.offset))
      if (params.limit !== undefined) qs.set('limit', String(params.limit))
      if (params.search) qs.set('search', params.search)
      if (params.status) qs.set('status', params.status)
      params.scene?.forEach((v) => qs.append('scene', v))
      params.season?.forEach((v) => qs.append('season', v))
      params.weather?.forEach((v) => qs.append('weather', v))
      return this.request<{ items: ImageRecord[]; total: number }>(
        `/images?${qs.toString()}`,
      )
    },

    get: (id: string) => this.request<ImageRecord>(`/images/${id}`),

    updateTags: (id: string, tags: Record<string, string[]>) =>
      this.request(`/images/${id}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tags }),
      }),

    thumbnailUrl: (id: string, size: 128 | 300 | 800 = 300) =>
      `http://localhost:7879/api/images/${id}/thumbnail?size=${size}`,
  }

  // ── Stats ──

  stats = {
    dashboard: (projectId: string) =>
      this.request<DashboardStats>(
        `/stats/dashboard?project_id=${projectId}`,
      ),
  }

  // ── Matrix ──

  matrix = {
    get: (params: { project_id: string; row: string; col: string }) =>
      this.request<CoverageMatrix>(
        `/matrix?project_id=${params.project_id}&row=${params.row}&col=${params.col}`,
      ),
  }

  // ── Config ──

  config = {
    get: () => this.request<Record<string, string>>('/config'),

    update: (data: Record<string, string>) =>
      this.request('/config', {
        method: 'PUT',
        body: JSON.stringify({ data }),
      }),
  }
}

export const api = new APIClient()
