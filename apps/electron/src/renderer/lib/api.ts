import type {
  TaskRecord,
  ImageRecord,
  DashboardStats,
  CoverageMatrix,
  TaskProgressEvent,
} from './types'

const API_BASE = 'http://localhost:7879/api'


// ── Image list query shape (shared by list + listIds) ──────────────────────
//
// Multi-value fields (scene/season/.../style/...): each value becomes a
// repeated query param so the backend reads it as List[str]. Within one
// dimension the backend ORs them; across dimensions it ANDs.
export interface ImageListParams {
  project_id: string
  offset?: number
  limit?: number
  search?: string
  status?: string
  source_type?: string
  // Tag filters — 12 dimensions total (5 originals + 7 soft tags from S5.3.9)
  scene?: string[]
  facility?: string[]
  season?: string[]
  weather?: string[]
  angle?: string[]
  people?: string[]
  usage?: string[]
  style?: string[]
  mood?: string[]
  palette?: string[]
  theme?: string[]
  composition?: string[]
  // Folder navigation
  folder?: string           // exact match
  folder_prefix?: string    // includes subfolders
  // Filter by which prompt generated the image (uses
  // generation_metadata.prompt_id JSON extract on the backend)
  prompt_id?: string
  // Filter to derivatives of a given seed image (parent_id == this id)
  parent_id?: string
}

const TAG_DIMENSION_KEYS = [
  'scene', 'facility', 'season', 'weather', 'angle', 'people', 'usage',
  'style', 'mood', 'palette', 'theme', 'composition',
] as const

function buildImageQuery(params: ImageListParams): URLSearchParams {
  const qs = new URLSearchParams()
  qs.set('project_id', params.project_id)
  if (params.offset !== undefined) qs.set('offset', String(params.offset))
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.search) qs.set('search', params.search)
  if (params.status) qs.set('status', params.status)
  if (params.source_type) qs.set('source_type', params.source_type)
  for (const dim of TAG_DIMENSION_KEYS) {
    const values = (params as any)[dim] as string[] | undefined
    values?.forEach((v) => qs.append(dim, v))
  }
  if (params.folder !== undefined) qs.set('folder', params.folder)
  if (params.folder_prefix) qs.set('folder_prefix', params.folder_prefix)
  if (params.prompt_id) qs.set('prompt_id', params.prompt_id)
  if (params.parent_id) qs.set('parent_id', params.parent_id)
  return qs
}


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

    createBatch: (tasks: Array<{ type: string; project_id: string; parameters: Record<string, unknown> }>) =>
      this.request<{ task_ids: string[]; count: number }>('/tasks/batch', {
        method: 'POST',
        body: JSON.stringify({ tasks }),
      }),

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
    list: (params: ImageListParams) => {
      const qs = buildImageQuery(params)
      return this.request<{ items: ImageRecord[]; total: number }>(
        `/images?${qs.toString()}`,
      )
    },

    listIds: (params: ImageListParams) => {
      const qs = buildImageQuery(params)
      qs.delete('offset'); qs.delete('limit')
      return this.request<{ ids: string[]; count: number }>(
        `/images/ids?${qs.toString()}`,
      )
    },

    listFolders: (projectId: string, sourceType?: string) => {
      const qs = new URLSearchParams({ project_id: projectId })
      if (sourceType) qs.set('source_type', sourceType)
      return this.request<Array<{ folder: string; count: number }>>(
        `/images/folders?${qs.toString()}`,
      )
    },

    listDuplicateGroups: (projectId: string, offset = 0, limit = 50) => {
      const qs = new URLSearchParams({
        project_id: projectId, offset: String(offset), limit: String(limit),
      })
      return this.request<{
        total: number
        items: Array<{
          id: string
          kept_image_id: string
          image_count: number
          pending_count: number      // is_kept=false AND quality_status != 'rejected'
          avg_hamming_distance: number
          created_at: string | null
          members: Array<{
            id: string
            file_name: string
            width: number | null
            height: number | null
            file_size_kb: number | null
            blur_score: number | null
            relative_dir: string
            is_kept: boolean
            quality_status: string | null
            thumbnail_url: string
          }>
        }>
      }>(`/duplicate-groups?${qs.toString()}`)
    },

    setKeptImage: (groupId: string, imageId: string) =>
      this.request(`/duplicate-groups/${groupId}/set-kept`, {
        method: 'POST',
        body: JSON.stringify({ image_id: imageId }),
      }),

    dissolveGroup: (groupId: string) =>
      this.request(`/duplicate-groups/${groupId}/dissolve`, { method: 'POST' }),

    removeFromGroup: (groupId: string, imageId: string) =>
      this.request(`/duplicate-groups/${groupId}/remove-member`, {
        method: 'POST',
        body: JSON.stringify({ image_id: imageId }),
      }),

    acceptAllDuplicates: (projectId: string, minGroupSize?: number) =>
      this.request<{ ok: boolean; moved_to_trash: number }>(`/duplicate-groups/accept-all`, {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId, min_group_size: minGroupSize }),
      }),

    acceptGroup: (groupId: string) =>
      this.request<{ ok: boolean; moved_to_trash: number }>(`/duplicate-groups/${groupId}/accept`, {
        method: 'POST',
      }),

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

  // ── Batches (Phase 2) ──

  batches = {
    list: (params?: { project_id?: string; status?: string }) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return this.request<BatchRunRecord[]>(`/batches${qs ? `?${qs}` : ''}`)
    },

    get: (id: string) => this.request<BatchRunRecord>(`/batches/${id}`),

    create: (body: BatchCreateBody) =>
      this.request<BatchRunRecord>('/batches', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    start: (id: string) =>
      this.request(`/batches/${id}/start`, { method: 'POST' }),

    pause: (id: string) =>
      this.request(`/batches/${id}/pause`, { method: 'POST' }),

    resume: (id: string) =>
      this.request(`/batches/${id}/resume`, { method: 'POST' }),

    cancel: (id: string) =>
      this.request(`/batches/${id}/cancel`, { method: 'POST' }),

    retryFailed: (id: string) =>
      this.request(`/batches/${id}/retry-failed`, { method: 'POST' }),

    cancelByPrompt: (batchId: string, promptId: string) =>
      this.request<{ status: string; cancelled: number }>(
        `/batches/${batchId}/cancel-by-prompt/${promptId}`, { method: 'POST' },
      ),

    cancelBySeed: (batchId: string, seedId: string) =>
      this.request<{ status: string; cancelled: number }>(
        `/batches/${batchId}/cancel-by-seed/${seedId}`, { method: 'POST' },
      ),

    listSubtasks: (id: string, params?: { status?: string; prompt_id?: string; seed_image_id?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString()
      return this.request<BatchSubtaskRecord[]>(`/batches/${id}/subtasks${qs ? `?${qs}` : ''}`)
    },

    groupByPrompt: (id: string) =>
      this.request<BatchPromptGroup[]>(`/batches/${id}/group-by-prompt`),

    delete: (id: string) =>
      this.request(`/batches/${id}`, { method: 'DELETE' }),

    subscribeProgress(id: string, onMessage: (e: BatchProgressEvent) => void): () => void {
      const es = new EventSource(`${API_BASE}/batches/${id}/stream`)
      es.onmessage = (e) => {
        try { onMessage(JSON.parse(e.data)) } catch { /* ignore keep-alives */ }
      }
      return () => es.close()
    },
  }

  // ── Prompts (Phase 2) ──

  prompts = {
    list: (params?: { category?: string; task_type?: string; is_active?: boolean; tag?: string; q?: string }) => {
      const qs = new URLSearchParams()
      if (params?.category) qs.set('category', params.category)
      if (params?.task_type) qs.set('task_type', params.task_type)
      if (params?.is_active !== undefined) qs.set('is_active', String(params.is_active))
      if (params?.tag) qs.set('tag', params.tag)
      if (params?.q) qs.set('q', params.q)
      return this.request<PromptRecord[]>(`/prompts${qs.toString() ? `?${qs}` : ''}`)
    },
  }
}

export interface BatchRunRecord {
  id: string
  project_id: string
  name: string
  task_type: string
  strategy_id: string | null
  seed_image_ids: string[]
  prompt_ids: string[]
  total: number
  completed: number
  failed: number
  skipped: number
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  concurrency: number
  max_retry: number
  provider_chain: string[] | null
  budget_usd: number | null
  cost_usd: number
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface BatchSubtaskRecord {
  id: string
  batch_id: string
  seed_image_id: string
  prompt_id: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'retrying' | 'skipped'
  retry_count: number
  output_image_id: string | null
  cost_usd: number | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
}

export interface BatchPromptGroup {
  prompt_id: string
  total: number
  by_status: Record<string, number>
  cost_usd: number
}

export interface BatchProgressEvent {
  event: string
  total?: number
  completed?: number
  failed?: number
  skipped?: number
  cost_usd?: number
  subtask_id?: string
  provider?: string
  error?: string
}

export interface BatchCreateBody {
  project_id: string
  name: string
  task_type: string
  seed_image_ids: string[]
  prompt_ids: string[]
  strategy_id?: string
  concurrency?: number
  max_retry?: number
  provider_chain?: string[]
  budget_usd?: number
}

export interface PromptRecord {
  id: string
  name: string
  category: string
  content: string
  is_default: boolean
  task_type: string | null
  negative_prompt: string | null
  tags: string[] | null
  stats: { success_count?: number; fail_count?: number; avg_cost_usd?: number; last_used_at?: string } | null
  is_active: boolean
  version: number
  parent_id: string | null
  created_at: string
  updated_at: string
}

export const api = new APIClient()
