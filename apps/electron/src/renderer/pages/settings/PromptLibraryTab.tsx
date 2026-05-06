import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { FileText, FileUp, GitBranch, Pencil, Plus, Search, Star, Trash2, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ExportImportButtons } from '@/components/settings/ExportImportButtons'

const API = 'http://localhost:7879/api/prompts'
const DOCS_API = 'http://localhost:7879/api/prompt-docs'

const CATEGORIES = [
  { value: 'tagging', label: '打标' },
  { value: 'seasonal', label: '季节变换' },
  { value: 'style', label: '风格变换' },
  { value: 'outpaint', label: '画布扩展' },
  { value: 'inpaint', label: '局部编辑' },
  { value: 'marketing', label: '营销素材' },
  { value: 'other', label: '其他' },
]

const TASK_TYPES = [
  { value: 'outpaint', label: 'outpaint' },
  { value: 'style', label: 'style' },
  { value: 'seasonal', label: 'seasonal' },
  { value: 'inpaint', label: 'inpaint' },
  { value: 'marketing', label: 'marketing' },
  { value: 'custom', label: 'custom' },
  { value: 'tag', label: 'tag' },
]

interface PromptStats {
  success_count?: number
  fail_count?: number
  avg_cost_usd?: number
  last_used_at?: string
}

interface PromptRecord {
  id: string
  name: string
  category: string
  content: string
  is_default: boolean
  task_type: string | null
  negative_prompt: string | null
  variables: Array<{ name: string; type: string; options?: string[] }> | null
  source: string | null
  source_doc_id: string | null
  tags: string[] | null
  stats: PromptStats | null
  is_active: boolean
  version: number
  parent_id: string | null
  created_at: string
  updated_at: string
}

function successRate(stats?: PromptStats | null): number | null {
  if (!stats) return null
  const total = (stats.success_count ?? 0) + (stats.fail_count ?? 0)
  if (total === 0) return null
  return (stats.success_count ?? 0) / total
}

export function PromptLibraryTab() {
  const queryClient = useQueryClient()
  const [filterCat, setFilterCat] = useState('all')
  const [filterTask, setFilterTask] = useState('all')
  const [filterTag, setFilterTag] = useState('')
  const [search, setSearch] = useState('')
  const [editingPrompt, setEditingPrompt] = useState<PromptRecord | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const { data: prompts, isLoading } = useQuery<PromptRecord[]>({
    queryKey: ['prompts', filterCat, filterTask, filterTag, search],
    queryFn: () => {
      const qs = new URLSearchParams()
      if (filterCat !== 'all') qs.set('category', filterCat)
      if (filterTask !== 'all') qs.set('task_type', filterTask)
      if (filterTag) qs.set('tag', filterTag)
      if (search) qs.set('q', search)
      const url = qs.toString() ? `${API}?${qs}` : API
      return fetch(url).then((r) => r.json())
    },
  })

  const allTags = useMemo(() => {
    const set = new Set<string>()
    prompts?.forEach((p) => p.tags?.forEach((t) => set.add(t)))
    return Array.from(set).sort()
  }, [prompts])

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`${API}/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('已删除')
      queryClient.invalidateQueries({ queryKey: ['prompts'] })
    },
  })

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: ['prompts'] })
    setShowCreate(false)
    setEditingPrompt(null)
  }

  return (
    <div className="space-y-4 max-w-4xl">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-foreground/40" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称/内容"
            className="h-8 pl-7 text-[12px]"
          />
        </div>
        <select
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          className="h-8 w-28 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
        >
          <option value="all">全部分类</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={filterTask}
          onChange={(e) => setFilterTask(e.target.value)}
          className="h-8 w-28 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
        >
          <option value="all">全部 task_type</option>
          {TASK_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        {allTags.length > 0 && (
          <select
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            className="h-8 w-28 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
          >
            <option value="">全部标签</option>
            {allTags.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
        <span className="text-[12px] text-foreground/40">{prompts?.length ?? 0} 个模板</span>
        <div className="ml-auto flex gap-2 items-center">
          <ExportImportButtons
            domainLabel="提示词模板"
            exportPath="/prompts/export"
            importPath="/prompts/import"
            exportFilename="lintu-prompts.json"
            onImportDone={() => queryClient.invalidateQueries({ queryKey: ['prompts'] })}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[12px]"
            onClick={() => setShowImport(true)}
          >
            <FileUp size={14} className="mr-1" /> 导入文档
          </Button>
          <Button size="sm" className="h-8 text-[12px]" onClick={() => setShowCreate(true)}>
            <Plus size={14} className="mr-1" /> 新建模板
          </Button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-foreground/[0.02] animate-pulse" />
          ))}
        </div>
      ) : !prompts?.length ? (
        <div className="text-center py-12 text-[13px] text-foreground/30">
          暂无 Prompt 模板，点击右上角新建或导入
        </div>
      ) : (
        <div className="space-y-2">
          {prompts.map((p) => {
            const sr = successRate(p.stats)
            const totalRuns = (p.stats?.success_count ?? 0) + (p.stats?.fail_count ?? 0)
            return (
              <div
                key={p.id}
                className="rounded-lg border border-foreground/5 p-3 group hover:border-foreground/10 transition-colors"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-foreground/80">{p.name}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                      {CATEGORIES.find((c) => c.value === p.category)?.label || p.category}
                    </Badge>
                    {p.task_type && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {p.task_type}
                      </Badge>
                    )}
                    {(p.version ?? 1) > 1 && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-foreground/40">
                        <GitBranch size={10} /> v{p.version}
                      </span>
                    )}
                    {p.source === 'imported' && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-info/30 text-info">
                        导入
                      </Badge>
                    )}
                    {!p.is_active && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-destructive/30 text-destructive">
                        已停用
                      </Badge>
                    )}
                    {p.is_default && <Star size={11} className="text-info fill-info" />}
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => setEditingPrompt(p)}
                    >
                      <Pencil size={12} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive"
                      onClick={() => deleteMutation.mutate(p.id)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-foreground/40 line-clamp-2 whitespace-pre-wrap">
                  {p.content}
                </p>
                {(p.tags?.length || sr !== null) && (
                  <div className="mt-2 flex items-center gap-3 text-[10px] text-foreground/40">
                    {p.tags?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {p.tags.map((t) => (
                          <span
                            key={t}
                            className="px-1.5 py-0.5 rounded-sm bg-foreground/[0.04] text-foreground/50"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {sr !== null && (
                      <span>
                        成功率 {(sr * 100).toFixed(0)}% · {totalRuns} 次
                        {p.stats?.avg_cost_usd != null && (
                          <> · 均价 ${p.stats.avg_cost_usd.toFixed(3)}</>
                        )}
                      </span>
                    )}
                    {p.stats?.last_used_at && (
                      <span>最近使用 {new Date(p.stats.last_used_at).toLocaleDateString()}</span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <PromptDialog
        open={showCreate || !!editingPrompt}
        onClose={() => { setShowCreate(false); setEditingPrompt(null) }}
        prompt={editingPrompt}
        onSaved={onSaved}
      />

      {/* Import Doc Dialog (placeholder) */}
      <ImportDocDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => {
          setShowImport(false)
          queryClient.invalidateQueries({ queryKey: ['prompts'] })
        }}
      />
    </div>
  )
}

function PromptDialog({ open, onClose, prompt, onSaved }: {
  open: boolean
  onClose: () => void
  prompt: PromptRecord | null
  onSaved: () => void
}) {
  const isEdit = !!prompt
  const [name, setName] = useState('')
  const [category, setCategory] = useState('tagging')
  const [taskType, setTaskType] = useState<string>('')
  const [content, setContent] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [saveAsNewVersion, setSaveAsNewVersion] = useState(true)

  useEffect(() => {
    if (prompt) {
      setName(prompt.name)
      setCategory(prompt.category)
      setTaskType(prompt.task_type ?? '')
      setContent(prompt.content)
      setNegativePrompt(prompt.negative_prompt ?? '')
      setTagsText((prompt.tags ?? []).join(', '))
      setIsDefault(prompt.is_default)
      setSaveAsNewVersion(true)
    } else {
      setName('')
      setCategory('tagging')
      setTaskType('')
      setContent('')
      setNegativePrompt('')
      setTagsText('')
      setIsDefault(false)
      setSaveAsNewVersion(true)
    }
  }, [prompt])

  const saveMutation = useMutation({
    mutationFn: () => {
      const tags = tagsText
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const body = {
        name,
        category,
        content,
        is_default: isDefault,
        task_type: taskType || null,
        negative_prompt: negativePrompt || null,
        tags: tags.length ? tags : null,
      }
      if (isEdit && saveAsNewVersion) {
        return fetch(`${API}/${prompt!.id}/duplicate-as-version`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json())
      }
      const url = isEdit ? `${API}/${prompt!.id}` : API
      return fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    },
    onSuccess: () => {
      toast.success(isEdit ? (saveAsNewVersion ? '已保存为新版本' : '模板已更新') : '模板已创建')
      onSaved()
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {isEdit ? `编辑模板${(prompt?.version ?? 1) > 1 ? ` · v${prompt?.version}` : ''}` : '新建 Prompt 模板'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-[12px] text-foreground/50">模板名称</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：春季樱花画面扩展"
                className="h-8 text-[13px]"
              />
            </div>
            <div className="w-32 space-y-1">
              <label className="text-[12px] text-foreground/50">分类</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="w-32 space-y-1">
              <label className="text-[12px] text-foreground/50">task_type</label>
              <select
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                className="w-full h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px] text-foreground/80"
              >
                <option value="">— 不限 —</option>
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">Prompt 内容</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入 Prompt 内容，可使用 {season}、{scene} 等变量占位符..."
              className="min-h-[160px] text-[13px] font-mono"
            />
            <p className="text-[10px] text-foreground/30">
              支持变量: {'{season}'}, {'{scene}'}, {'{weather}'}, {'{angle}'} 等，运行时自动替换
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">反向提示词 (negative prompt)</label>
            <Textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="可选，例如：模糊、低质量、变形"
              className="min-h-[60px] text-[13px] font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">标签（逗号分隔）</label>
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="例如：小红书, 竖版, 冷色调"
              className="h-8 text-[13px]"
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1 text-[12px] text-foreground/60">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              设为该分类的默认模板
            </label>
            {isEdit && (
              <label className="flex items-center gap-1 text-[12px] text-foreground/60">
                <input
                  type="checkbox"
                  checked={saveAsNewVersion}
                  onChange={(e) => setSaveAsNewVersion(e.target.checked)}
                />
                保存为新版本（保留历史）
              </label>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={!name || !content || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {isEdit ? (saveAsNewVersion ? '保存为新版本' : '原地保存') : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ParsedEntry {
  name: string
  content: string
  category?: string | null
  task_type?: string | null
  tags?: string[] | null
  negative_prompt?: string | null
}

interface DocStatus {
  id: string
  parse_status: 'pending' | 'parsing' | 'success' | 'failed'
  parsed_count?: number
  parsed_payload?: ParsedEntry[]
  parse_error?: string
}

interface ProgressEvent {
  phase: string
  msg?: string
  format?: string
  filename?: string
  chars?: number
  pages?: number
  total_pages?: number
  page?: number
  total?: number
  provider?: string
  model?: string
  input_chars?: number
  text?: string                  // raw LLM chunk tail
  index?: number
  entry?: ParsedEntry
  entries?: ParsedEntry[]
  count?: number
  error?: string
}

const RAW_TAIL_MAX = 600

function ImportDocDialog({ open, onClose, onImported }: {
  open: boolean
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [docId, setDocId] = useState<string | null>(null)
  const [parseStatus, setParseStatus] = useState<DocStatus['parse_status']>('pending')
  const [entries, setEntries] = useState<ParsedEntry[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [parseError, setParseError] = useState<string | null>(null)
  // Streaming progress state
  const [phase, setPhase] = useState<string>('')
  const [phaseDetail, setPhaseDetail] = useState<string>('')
  const [rawTail, setRawTail] = useState<string>('')
  const [showRaw, setShowRaw] = useState(false)
  const sseRef = useRef<EventSource | null>(null)

  const reset = () => {
    if (sseRef.current) {
      sseRef.current.close()
      sseRef.current = null
    }
    setFile(null)
    setDocId(null)
    setParseStatus('pending')
    setEntries([])
    setSelected(new Set())
    setParseError(null)
    setPhase('')
    setPhaseDetail('')
    setRawTail('')
    setShowRaw(false)
  }

  useEffect(() => {
    return () => {
      if (sseRef.current) sseRef.current.close()
    }
  }, [])

  const handleEvent = (e: ProgressEvent) => {
    setPhase(e.phase)
    switch (e.phase) {
      case 'started':
        setPhaseDetail(`开始解析 ${e.filename || ''}`)
        break
      case 'extracting':
        setPhaseDetail(`读取 ${e.format} 文档…`)
        break
      case 'extracted_text':
        setPhaseDetail(`PDF 文字层提取 ${e.chars} 字符`)
        break
      case 'rendered_pages':
        setPhaseDetail(`PDF 渲染为 ${e.pages} 页图像`)
        break
      case 'ocr_start':
        setPhaseDetail(`视觉 OCR：${e.provider} · ${e.total_pages} 页`)
        break
      case 'ocr_page':
        setPhaseDetail(`视觉 OCR 第 ${e.page}/${e.total} 页…`)
        break
      case 'ocr_page_failed':
        setPhaseDetail(`第 ${e.page} 页 OCR 失败：${e.error}`)
        break
      case 'extracted':
        setPhaseDetail(`文档共 ${e.chars} 字符，准备调用 LLM…`)
        break
      case 'llm_start':
        setPhaseDetail(`调用 ${e.provider} (${e.model}) · 输入 ${e.input_chars} 字符…`)
        setRawTail('')
        break
      case 'chunk':
        if (e.text) {
          setRawTail((prev) => (prev + e.text!).slice(-RAW_TAIL_MAX))
        }
        break
      case 'entry':
        if (e.entry) {
          setEntries((prev) => {
            const next = [...prev, e.entry!]
            setSelected((s) => new Set([...Array.from(s), next.length - 1]))
            return next
          })
          setPhaseDetail(`已识别 ${(e.index ?? 0) + 1} 条 prompt…`)
        }
        break
      case 'heartbeat':
        // No UI change — just keeps connection alive
        break
      case 'complete':
        if (e.entries && e.entries.length > 0) {
          setEntries(e.entries)
          setSelected(new Set(e.entries.map((_, i) => i)))
        }
        setPhaseDetail(`完成，共 ${e.count} 条`)
        setParseStatus('success')
        if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
        break
      case 'failed':
        setParseError(e.error || '解析失败')
        setParseStatus('failed')
        if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
        break
    }
  }

  const startStream = (id: string) => {
    if (sseRef.current) sseRef.current.close()
    const es = new EventSource(`${DOCS_API}/${id}/stream`)
    sseRef.current = es
    es.onmessage = (m) => {
      try { handleEvent(JSON.parse(m.data)) } catch { /* keep-alives */ }
    }
    es.onerror = () => {
      // EventSource auto-reconnects; only mark failed if not already terminal
      if (parseStatus === 'parsing') {
        // Soft-keep — server might be temporarily slow. The browser retries.
      }
    }
  }

  // Step 1: upload
  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('没有选择文件')
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`${DOCS_API}/upload`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<{ id: string }>
    },
    onSuccess: async (data) => {
      setDocId(data.id)
      setParseStatus('parsing')
      // Subscribe BEFORE triggering parse so we don't miss the started event
      startStream(data.id)
      const parseRes = await fetch(`${DOCS_API}/${data.id}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!parseRes.ok) {
        const err = await parseRes.text()
        toast.error(`解析触发失败: ${err}`)
        setParseError(err)
        setParseStatus('failed')
      }
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const retryParse = async () => {
    if (!docId) return
    setEntries([])
    setSelected(new Set())
    setParseError(null)
    setRawTail('')
    setPhase('')
    setPhaseDetail('')
    setParseStatus('parsing')
    startStream(docId)
    const res = await fetch(`${DOCS_API}/${docId}/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })
    if (!res.ok) {
      setParseError(await res.text())
      setParseStatus('failed')
    }
  }

  // Step 3: confirm import
  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!docId) throw new Error('no doc_id')
      const indexes = Array.from(selected).sort((a, b) => a - b)
      const res = await fetch(`${DOCS_API}/${docId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected_indexes: indexes }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json() as Promise<{ imported: number }>
    },
    onSuccess: (data) => {
      toast.success(`已导入 ${data.imported} 条 prompt`)
      reset()
      onImported()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const toggleAll = () => {
    if (selected.size === entries.length) setSelected(new Set())
    else setSelected(new Set(entries.map((_, i) => i)))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-[15px]">导入提示词文档</DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-[11px] text-foreground/60 pb-2">
          <span className={parseStatus === 'pending' && !docId ? 'font-medium text-foreground' : ''}>1. 上传</span>
          <span>→</span>
          <span className={parseStatus === 'parsing' ? 'font-medium text-foreground' : ''}>2. AI 解析</span>
          <span>→</span>
          <span className={parseStatus === 'success' ? 'font-medium text-foreground' : ''}>3. 确认导入</span>
        </div>

        {!docId && (
          <div className="space-y-3 py-2">
            <FileDropZone file={file} onFileChange={setFile} />
            <p className="text-[10px] text-foreground/40">
              支持格式：md / txt / docx / xlsx / pdf。
              AI 会自动识别多条 prompt 并结构化；扫描型 PDF 走视觉 OCR 兜底（最多 20 页）。
            </p>
          </div>
        )}

        {/* Compact progress strip — shown while parsing or after failure */}
        {docId && (parseStatus === 'parsing' || parseStatus === 'failed') && (
          <ProgressStrip
            status={parseStatus}
            phase={phase}
            detail={phaseDetail}
            entryCount={entries.length}
            rawTail={rawTail}
            showRaw={showRaw}
            onToggleRaw={() => setShowRaw((v) => !v)}
            error={parseError}
          />
        )}

        {/* Entry list — visible as soon as first entry streams in */}
        {entries.length > 0 && (
          <div className="space-y-2 py-2">
            <div className="flex items-center justify-between text-[11px] text-foreground/60">
              <span>
                识别到 {entries.length} 条 prompt
                {parseStatus === 'parsing' && (
                  <span className="ml-1.5 text-info">（仍在解析中…）</span>
                )}
              </span>
              <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={toggleAll}>
                {selected.size === entries.length ? '全不选' : '全选'}
              </Button>
            </div>
            <div className="space-y-1.5 max-h-[400px] overflow-y-auto pr-1">
              {entries.map((e, idx) => (
                <label
                  key={idx}
                  className="flex gap-2 rounded-md border border-foreground/5 p-2 hover:border-foreground/10 cursor-pointer animate-in fade-in duration-200"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(idx)}
                    onChange={() => {
                      const next = new Set(selected)
                      if (next.has(idx)) next.delete(idx)
                      else next.add(idx)
                      setSelected(next)
                    }}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <span className="text-[12px] font-medium text-foreground/80">{e.name}</span>
                      {e.category && (
                        <Badge variant="secondary" className="text-[9px] px-1 py-0">{e.category}</Badge>
                      )}
                      {e.task_type && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0">{e.task_type}</Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-foreground/50 line-clamp-2 whitespace-pre-wrap">
                      {e.content}
                    </p>
                    {e.tags && e.tags.length > 0 && (
                      <div className="mt-1 flex gap-1 flex-wrap">
                        {e.tags.map((t) => (
                          <span key={t} className="text-[9px] px-1 rounded-sm bg-foreground/[0.04] text-foreground/40">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {parseStatus === 'success' && entries.length === 0 && (
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3 text-[12px] text-foreground/60">
            AI 没有从文档中识别出任何 prompt。请检查文档内容或尝试其他格式。
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          {!docId && (
            <Button
              size="sm"
              disabled={!file || uploadMutation.isPending}
              onClick={() => uploadMutation.mutate()}
            >
              {uploadMutation.isPending ? '上传中…' : '上传并开始解析'}
            </Button>
          )}
          {parseStatus === 'failed' && docId && (
            <Button size="sm" onClick={retryParse}>重新解析</Button>
          )}
          {parseStatus === 'success' && entries.length > 0 && (
            <Button
              size="sm"
              disabled={selected.size === 0 || confirmMutation.isPending}
              onClick={() => confirmMutation.mutate()}
            >
              导入选中的 {selected.size} 条
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const ACCEPT_EXT = '.md,.markdown,.txt,.docx,.xlsx,.pdf'
const ACCEPT_SET = new Set(['md', 'markdown', 'txt', 'docx', 'xlsx', 'pdf'])

function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function FileDropZone({ file, onFileChange }: {
  file: File | null
  onFileChange: (f: File | null) => void
}) {
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const acceptFile = (f: File | null | undefined) => {
    if (!f) return
    const ext = fileExt(f.name)
    if (!ACCEPT_SET.has(ext)) {
      setError(`不支持的格式：.${ext || '?'}`)
      return
    }
    setError(null)
    onFileChange(f)
  }

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    acceptFile(e.dataTransfer.files?.[0])
  }

  if (file) {
    return (
      <div className="rounded-lg border border-foreground/10 bg-foreground/[0.02] p-4 flex items-center gap-3">
        <div className="h-10 w-10 rounded-md bg-info/10 text-info flex items-center justify-center shrink-0">
          <FileText size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground/85 truncate">{file.name}</div>
          <div className="text-[11px] text-foreground/45 mt-0.5">
            {formatBytes(file.size)} · {fileExt(file.name).toUpperCase()}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0 text-foreground/40 hover:text-destructive"
          onClick={() => {
            onFileChange(null)
            if (inputRef.current) inputRef.current.value = ''
          }}
          title="移除文件"
        >
          <X size={14} />
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_EXT}
          className="hidden"
          onChange={(e) => acceptFile(e.target.files?.[0])}
        />
      </div>
    )
  }

  return (
    <div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragActive(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragActive(false)
        }}
        onDrop={onDrop}
        className={cn(
          'rounded-lg border border-dashed py-8 px-4 text-center cursor-pointer transition-colors',
          dragActive
            ? 'border-info/60 bg-info/[0.04]'
            : 'border-foreground/15 bg-foreground/[0.015] hover:border-foreground/25 hover:bg-foreground/[0.03]',
        )}
      >
        <Upload
          size={26}
          className={cn(
            'mx-auto mb-2',
            dragActive ? 'text-info' : 'text-foreground/35',
          )}
        />
        <div className="text-[13px] text-foreground/75">
          拖拽文件到此处，或<span className="text-info">点击选择</span>
        </div>
        <div className="text-[10px] text-foreground/40 mt-1">
          MD · TXT · DOCX · XLSX · PDF
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_EXT}
          className="hidden"
          onChange={(e) => acceptFile(e.target.files?.[0])}
        />
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-destructive">{error}</p>
      )}
    </div>
  )
}

// ── Compact streaming progress strip ────────────────────────────────────────

function ProgressStrip({
  status, phase, detail, entryCount, rawTail, showRaw, onToggleRaw, error,
}: {
  status: 'parsing' | 'failed'
  phase: string
  detail: string
  entryCount: number
  rawTail: string
  showRaw: boolean
  onToggleRaw: () => void
  error: string | null
}) {
  const isFailed = status === 'failed'
  const isOcr = phase.startsWith('ocr')
  const isLlm = phase === 'chunk' || phase === 'entry' || phase === 'llm_start' || phase === 'heartbeat'
  return (
    <div className={cn(
      'rounded-md border px-3 py-2.5 text-[12px] space-y-1.5',
      isFailed
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-info/25 bg-info/[0.04]'
    )}>
      <div className="flex items-center gap-2">
        {isFailed ? (
          <span className="h-2 w-2 rounded-full bg-destructive shrink-0" />
        ) : (
          <span className="h-2 w-2 rounded-full bg-info animate-pulse shrink-0" />
        )}
        <span className="font-medium text-foreground/80">
          {isFailed ? '解析失败' : isOcr ? '视觉 OCR' : isLlm ? 'LLM 解析中' : '准备中'}
        </span>
        <span className="text-foreground/55 truncate">{detail || phase}</span>
        {entryCount > 0 && (
          <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0 shrink-0">
            已识别 {entryCount}
          </Badge>
        )}
      </div>
      {isFailed && error && (
        <p className="text-[11px] text-destructive leading-snug">{error}</p>
      )}
      {isFailed && (
        <p className="text-[10px] text-foreground/50">
          提示：在「设置 → AI 服务商 → 模型分配」检查通用模型配置后，点下方「重新解析」。
        </p>
      )}
      {!isFailed && (
        <div>
          <button
            onClick={onToggleRaw}
            className="text-[10px] text-foreground/50 hover:text-foreground/80 inline-flex items-center gap-1"
          >
            {showRaw ? '▾ 收起' : '▸ 实时输出'}
            {rawTail && <span className="text-foreground/30">({rawTail.length} 字符)</span>}
          </button>
          {showRaw && (
            <pre className="mt-1.5 max-h-24 overflow-y-auto rounded bg-foreground/[0.04] px-2 py-1.5 text-[10px] leading-relaxed text-foreground/55 font-mono whitespace-pre-wrap">
              {rawTail || '（等待第一个 chunk…）'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
