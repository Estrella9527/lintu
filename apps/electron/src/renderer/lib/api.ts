import type {
  TaskRecord,
  ImageRecord,
  DashboardStats,
  CoverageMatrix,
  TaskProgressEvent,
} from './types'

// 强制 IPv4 — sidecar 只监听 127.0.0.1。Chromium / Electron 在解析 localhost
// 时可能会优先 IPv6 ::1 → connection refused → "Failed to fetch"。直接写
// 127.0.0.1 绕过 DNS 歧义，所有 fetch / EventSource / <img> 全走 IPv4。
const API_BASE = 'http://127.0.0.1:7879/api'


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


/** Error subclass that preserves HTTP status + parsed body so callers can
 *  do structured error handling (e.g. 409 conflict UX) without re-parsing
 *  the message string. */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message || `API Error ${status}`)
    this.status = status
    this.body = body
  }
}

// ── 登录 token 内存缓存 + main 进程 safeStorage 同步 ─────────────────────
// 每次启动 App 时由 AuthGate 调 hydrateAuthToken() 从 safeStorage 拉一次。
// 登录成功后 setAuthToken() 同时写内存 + 落盘。登出 / 401 时 clearAuthToken()。
let _authToken: string | null = null
type AuthLoggedOutListener = () => void
const _logoutListeners = new Set<AuthLoggedOutListener>()

export async function hydrateAuthToken(): Promise<void> {
  const ipc = (typeof window !== 'undefined' ? (window as any).updaterAPI?.authToken : null)
  if (!ipc?.get) return
  try { _authToken = await ipc.get() } catch { _authToken = null }
}

export function getAuthToken(): string | null {
  return _authToken
}

export async function setAuthToken(token: string): Promise<void> {
  _authToken = token
  const ipc = (window as any).updaterAPI?.authToken
  if (ipc?.set) {
    try { await ipc.set(token) } catch { /* ignore — token 还在内存里至少能用 */ }
  }
}

export async function clearAuthToken(): Promise<void> {
  _authToken = null
  const ipc = (window as any).updaterAPI?.authToken
  if (ipc?.clear) {
    try { await ipc.clear() } catch { /* ignore */ }
  }
  // 通知所有订阅者（atoms / AuthGate 重渲染）
  _logoutListeners.forEach((cb) => { try { cb() } catch {} })
}

/** 当 401 触发自动登出时，订阅者会被调用。 */
export function onAuthLoggedOut(cb: AuthLoggedOutListener): () => void {
  _logoutListeners.add(cb)
  return () => { _logoutListeners.delete(cb) }
}

/**
 * Drop-in 替代原生 `fetch()` — 唯一改动是自动注入 Bearer token + 401 自动登出。
 * 保持返回 `Response`，所以现有 `.then(r => r.json())` 调用风格不需要改。
 *
 * 用法（与 fetch 完全一致）：
 *   apiFetchRaw('/projects').then(r => r.json())
 *   apiFetchRaw('/projects/xxx', { method: 'DELETE' })
 *
 * path 不带 `/api` 前缀（API_BASE 已含）。
 */
export async function apiFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  }
  // 只对带 body 的请求设 Content-Type（GET 不必，避免缩略图被加 Content-Type 干扰）
  if (init?.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json'
  }
  if (_authToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${_authToken}`
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    await clearAuthToken()
  }
  return res
}

/**
 * 把当前 token 拼到一个完整 URL 的 query 上 — 给 <img> / <a download> /
 * EventSource 这类原生标签用（无法塞自定义请求头）。已带 ?... 的 URL 用 &，
 * 否则用 ?。token 缺失时原样返回（避免 dev BYPASS 模式下污染 URL）。
 */
export function withTokenParam(url: string): string {
  if (!_authToken) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(_authToken)}`
}

/**
 * 解析 JSON + 自动抛 ApiError 的强类型版本。新代码优先用这个。
 */
export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (_authToken && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${_authToken}`
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // token 失效：清空 + 通知 AuthGate 跳登录页（登录端点除外，避免循环）
    await clearAuthToken()
  }
  if (!res.ok) {
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep raw text */ }
    throw new ApiError(res.status, body, `API Error ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

class APIClient {
  private request<T>(path: string, init?: RequestInit): Promise<T> {
    return apiFetch<T>(path, init)
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
      const es = new EventSource(withTokenParam(`${API_BASE}/tasks/${id}/stream`))
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
      withTokenParam(`http://localhost:7879/api/images/${id}/thumbnail?size=${size}`),
    fileUrl: (id: string) =>
      withTokenParam(`http://localhost:7879/api/images/${id}/file`),
    downloadUrl: (id: string) =>
      withTokenParam(`http://localhost:7879/api/images/${id}/download`),
  }

  // ── Stats ──

  stats = {
    dashboard: (projectId: string) =>
      this.request<DashboardStats>(
        `/stats/dashboard?project_id=${projectId}`,
      ),
  }

  // ── Auth (用户系统 Phase 1) ──
  auth = {
    sendSms: (phone: string) =>
      this.request<{ ok: boolean; ttl_sec: number }>('/auth/sms/send', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      }),

    verifySms: (phone: string, code: string) =>
      this.request<{ token: string; user: import('@/atoms/auth').CurrentUser }>(
        '/auth/sms/verify',
        { method: 'POST', body: JSON.stringify({ phone, code }) },
      ),

    me: () => this.request<import('@/atoms/auth').CurrentUser>('/auth/me'),

    updateMe: (body: { display_name?: string; avatar_url?: string }) =>
      this.request<import('@/atoms/auth').CurrentUser>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    logout: () =>
      this.request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

    refresh: () =>
      this.request<{ ok: boolean; expires_at: string }>('/auth/refresh', {
        method: 'POST',
      }),

    sessions: () => this.request<Array<{
      id: string
      device_label: string | null
      ip: string | null
      user_agent: string | null
      created_at: string | null
      expires_at: string | null
      is_current: boolean
    }>>('/auth/sessions'),

    revokeSession: (sessionId: string) =>
      this.request<{ ok: boolean }>(`/auth/sessions/${sessionId}`, {
        method: 'DELETE',
      }),
  }

  // ── Orgs (v0.2 组织化) ──
  orgs = {
    list: () => this.request<Array<import('@/atoms/auth').CurrentOrgSummary>>('/orgs'),
    get: (orgId: string) => this.request<import('@/atoms/auth').CurrentOrgSummary>(`/orgs/${orgId}`),
    create: (body: {
      name: string; slug: string; contact_email?: string;
      initial_owner_phone: string; plan?: string;
    }) => this.request<import('@/atoms/auth').CurrentOrgSummary>('/orgs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    update: (orgId: string, body: { name?: string; contact_email?: string; logo_url?: string }) =>
      this.request<import('@/atoms/auth').CurrentOrgSummary>(`/orgs/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (orgId: string) =>
      this.request<{ ok: boolean }>(`/orgs/${orgId}`, { method: 'DELETE' }),

    listMembers: (orgId: string) =>
      this.request<Array<{
        id: string; user_id: string; phone: string | null;
        display_name: string | null; avatar_url: string | null;
        role: string; invited_by: string | null; created_at: string | null;
      }>>(`/orgs/${orgId}/members`),
    addMember: (orgId: string, body: { phone: string; role?: string }) =>
      this.request<{ ok: boolean; user_id: string; phone: string; role: string }>(
        `/orgs/${orgId}/members`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    updateMember: (orgId: string, userId: string, role: string) =>
      this.request<{ ok: boolean }>(`/orgs/${orgId}/members/${userId}`, {
        method: 'PATCH', body: JSON.stringify({ role }),
      }),
    removeMember: (orgId: string, userId: string) =>
      this.request<{ ok: boolean }>(`/orgs/${orgId}/members/${userId}`, {
        method: 'DELETE',
      }),
  }

  // ── Platform (仅 platform owner) ──
  platform = {
    overview: () => this.request<{
      org_count: number; user_count: number; image_count: number;
      project_count: number; storage_used_gb: number;
    }>('/platform/overview'),
    listOrgs: () => this.request<Array<{
      id: string; name: string; slug: string; plan: string; status: string;
      storage_quota_gb: number; storage_used_gb: number;
      created_at: string | null; deleted_at: string | null;
      member_count: number; project_count: number;
    }>>('/platform/orgs'),
    listUsers: () => this.request<Array<{
      id: string; phone: string | null; display_name: string | null;
      is_platform_owner: boolean; is_root: boolean; status: string;
      last_login_at: string | null; created_at: string | null;
    }>>('/platform/users'),
  }

  // ── SMS 短信服务（仅平台超管可调） ──
  sms = {
    status: () => this.request<{
      configured: boolean
      sign_name: string | null
      template_code: string | null
      endpoint_resolved: string
      access_key_masked: string | null
    }>('/sms/status'),
    test: (phone: string) =>
      this.request<{ ok: boolean; message?: string; error?: string }>('/sms/test', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      }),
  }

  // ── Audit log（仅超级管理员可调） ──
  audit = {
    listOperations: (params?: {
      user_id?: string
      project_id?: string
      method?: string
      path_prefix?: string
      since?: string
      limit?: number
      offset?: number
    }) => {
      const qs = new URLSearchParams()
      if (params?.user_id) qs.set('user_id', params.user_id)
      if (params?.project_id) qs.set('project_id', params.project_id)
      if (params?.method) qs.set('method', params.method)
      if (params?.path_prefix) qs.set('path_prefix', params.path_prefix)
      if (params?.since) qs.set('since', params.since)
      if (params?.limit !== undefined) qs.set('limit', String(params.limit))
      if (params?.offset !== undefined) qs.set('offset', String(params.offset))
      const tail = qs.toString() ? `?${qs}` : ''
      return this.request<{
        items: Array<{
          id: number
          user_id: string | null
          user: { phone: string | null; display_name: string | null } | null
          project_id: string | null
          method: string
          path: string
          status_code: number | null
          summary: string | null
          ip: string | null
          user_agent: string | null
          created_at: string | null
        }>
        limit: number
        offset: number
        next_offset: number | null
      }>(`/audit/operations${tail}`)
    },
  }

  // ── Matrix ──

  matrix = {
    get: (params: { project_id: string; row: string; col: string }) =>
      this.request<CoverageMatrix>(
        `/matrix?project_id=${params.project_id}&row=${params.row}&col=${params.col}`,
      ),
  }

  // ── Config ──

  // ── Match analytics (匹配反馈看板) ──
  matchAnalytics = {
    /** Roll-up of calls / latency / feedback over the last `window_hours`.
     * Backend lives in routers/match_analytics.py. */
    overview: (windowHours = 168) =>
      this.request<import('./types').MatchAnalyticsOverview>(
        `/match/analytics?window_hours=${windowHours}`,
      ),
  }

  config = {
    get: () => this.request<Record<string, string>>('/config'),

    // Backend accepts any JSON-serializable value; callers commonly pass
    // strings / numbers / booleans / arrays. Using `unknown` here keeps
    // type safety at the call site without forcing every caller to
    // stringify integer / boolean fields.
    //
    // 乐观锁：如果 caller 传 ifVersion，服务端版本不一致会返回 409，
    // 由调用方决定如何处理（弹冲突对话框 / 强制覆盖 / 重新拉取）。
    update: (data: Record<string, unknown>, ifVersion?: number) =>
      this.request<{ ok: boolean; __version: number }>('/config', {
        method: 'PUT',
        body: JSON.stringify({ data, if_version: ifVersion ?? null }),
      }),

    /** 当前 sidecar 进程是否会把 config 改动推到云端 — 决定「匹配策略」
     * 等页面顶部该显示「只本地生效」还是「保存即同步线上 UGC」。 */
    syncStatus: () =>
      this.request<{
        enabled: boolean
        target_url: string | null
        has_token: boolean
        pending_jobs: number
      }>('/config/sync-status'),

    /** 近期 config 改动审计记录。可按 key 过滤；最新在前。 */
    auditLog: (params?: { key?: string; limit?: number }) => {
      const qs = new URLSearchParams()
      if (params?.key)   qs.set('key', params.key)
      if (params?.limit) qs.set('limit', String(params.limit))
      return this.request<Array<{
        id: number
        key: string
        old_value: unknown
        new_value: unknown
        source: 'desktop' | 'cloud_sync' | 'cli'
        actor_meta: { host?: string; pid?: number } | null
        created_at: string | null
      }>>(`/config/audit-log${qs.toString() ? `?${qs}` : ''}`)
    },

    /** Test OSS credentials WITHOUT saving — used by the OSS Connect tab's
     * 「测试连接」button before commit. */
    testOss: (body: {
      oss_provider: string
      oss_endpoint: string
      oss_bucket: string
      oss_access_key?: string
      oss_access_secret?: string
      oss_cdn_base?: string
    }) =>
      this.request<{ ok: boolean; mode?: string; code?: string; message?: string }>(
        '/config/oss/test',
        { method: 'POST', body: JSON.stringify(body) },
      ),
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
      const es = new EventSource(withTokenParam(`${API_BASE}/batches/${id}/stream`))
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
