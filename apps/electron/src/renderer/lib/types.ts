// ── API response types ──

export interface Project {
  id: string
  name: string
  originals_path: string
  workspace_path: string
  created_at: string
}

export interface ImageRecord {
  id: string
  project_id: string
  file_path: string
  file_name: string
  file_hash: string | null
  phash: string | null
  file_size_kb: number | null
  width: number | null
  height: number | null
  blur_score: number | null
  brightness: number | null
  quality_status: 'pending' | 'passed' | 'rejected'
  reject_reason: string | null
  dedup_group_id: string | null
  is_kept: boolean
  tag_status: 'pending' | 'tagged' | 'manual'
  tagged_at: string | null
  tag_provider: string | null
  description: string | null
  source_type: 'original' | 'generated'
  parent_id: string | null
  created_at: string
  updated_at: string
  tags: TagRecord[]
}

export interface TagRecord {
  id: string
  image_id: string
  dimension: string
  value: string
  confidence: number | null
  source: 'ai' | 'manual'
}

export interface TaskRecord {
  id: string
  project_id: string
  type: string
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  parameters: string | null
  total: number
  processed: number
  failed: number
  cost_usd: number
  started_at: string | null
  completed_at: string | null
  created_at: string
  error_message: string | null
}

export interface DashboardStats {
  counts: {
    total: number
    passed: number
    rejected: number
    tagged: number
    derivatives: number
  }
  rates: {
    quality_pass: number
    tag_progress: number
  }
  running_tasks: TaskRecord[]
  recent_tasks: TaskRecord[]
  tag_distribution: Array<{ dimension: string; value: string; count: number }>
}

export interface MatrixCell {
  row: string
  col: string
  count: number
  priority: 'P0' | 'P1' | 'P2'
}

export interface CoverageMatrix {
  row_dimension: string
  col_dimension: string
  row_values: string[]
  col_values: string[]
  cells: MatrixCell[]
  summary: {
    total_cells: number
    p0_gaps: number
    p1_gaps: number
    suggestions: Array<{
      gap: string
      current: number
      recommended_strategy: string
      description: string
    }>
  }
}

export interface TaskProgressEvent {
  processed: number
  total: number
  status?: string
  phase?: string
  cost_usd?: number
  passed_count?: number
  failed_count?: number
}

export interface ImageFilter {
  project_id: string
  search?: string
  scene?: string[]
  season?: string[]
  weather?: string[]
  status?: string
}
