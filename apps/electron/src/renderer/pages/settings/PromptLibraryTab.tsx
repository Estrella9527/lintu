import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

const API = 'http://localhost:7879/api/prompts'

const CATEGORIES = [
  { value: 'tagging', label: '打标' },
  { value: 'seasonal', label: '季节变换' },
  { value: 'style', label: '风格变换' },
  { value: 'outpaint', label: '画布扩展' },
  { value: 'inpaint', label: '局部编辑' },
  { value: 'marketing', label: '营销素材' },
  { value: 'other', label: '其他' },
]

interface PromptRecord {
  id: string
  name: string
  category: string
  content: string
  is_default: boolean
  created_at: string
}

export function PromptLibraryTab() {
  const queryClient = useQueryClient()
  const [filterCat, setFilterCat] = useState('all')
  const [editingPrompt, setEditingPrompt] = useState<PromptRecord | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data: prompts, isLoading } = useQuery<PromptRecord[]>({
    queryKey: ['prompts', filterCat],
    queryFn: () => {
      const url = filterCat === 'all' ? API : `${API}?category=${filterCat}`
      return fetch(url).then((r) => r.json())
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`${API}/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => { toast.success('已删除'); queryClient.invalidateQueries({ queryKey: ['prompts'] }) },
  })

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: ['prompts'] })
    setShowCreate(false)
    setEditingPrompt(null)
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={filterCat} onValueChange={setFilterCat}>
            <SelectTrigger className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[12px] text-foreground/40">{prompts?.length ?? 0} 个模板</span>
        </div>
        <Button size="sm" className="h-8 text-[12px]" onClick={() => setShowCreate(true)}>
          <Plus size={14} className="mr-1" /> 新建模板
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-lg bg-foreground/[0.02] animate-pulse" />)}</div>
      ) : !prompts?.length ? (
        <div className="text-center py-12 text-[13px] text-foreground/30">
          暂无 Prompt 模板，点击右上角新建
        </div>
      ) : (
        <div className="space-y-2">
          {prompts.map((p) => (
            <div key={p.id} className="rounded-lg border border-foreground/5 p-3 group hover:border-foreground/10 transition-colors">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground/80">{p.name}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {CATEGORIES.find((c) => c.value === p.category)?.label || p.category}
                  </Badge>
                  {p.is_default && <Star size={11} className="text-info fill-info" />}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setEditingPrompt(p)}>
                    <Pencil size={12} />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => deleteMutation.mutate(p.id)}>
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-foreground/40 line-clamp-2 whitespace-pre-wrap">{p.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <PromptDialog
        open={showCreate || !!editingPrompt}
        onClose={() => { setShowCreate(false); setEditingPrompt(null) }}
        prompt={editingPrompt}
        onSaved={onSaved}
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
  const [name, setName] = useState(prompt?.name || '')
  const [category, setCategory] = useState(prompt?.category || 'tagging')
  const [content, setContent] = useState(prompt?.content || '')
  const [isDefault, setIsDefault] = useState(prompt?.is_default || false)

  // Reset when prompt changes
  useEffect(() => {
    if (prompt) { setName(prompt.name); setCategory(prompt.category); setContent(prompt.content); setIsDefault(prompt.is_default) }
    else { setName(''); setCategory('tagging'); setContent(''); setIsDefault(false) }
  }, [prompt])

  const saveMutation = useMutation({
    mutationFn: () => {
      const body = { name, category, content, is_default: isDefault }
      const url = isEdit ? `${API}/${prompt!.id}` : API
      return fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    },
    onSuccess: () => { toast.success(isEdit ? '模板已更新' : '模板已创建'); onSaved() },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{isEdit ? '编辑模板' : '新建 Prompt 模板'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <label className="text-[12px] text-foreground/50">模板名称</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：景区打标 v2" className="h-8 text-[13px]" />
            </div>
            <div className="w-32 space-y-1">
              <label className="text-[12px] text-foreground/50">分类</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-foreground/50">Prompt 内容</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="输入 Prompt 内容，可使用 {season}、{scene} 等变量占位符..."
              className="min-h-[200px] text-[13px] font-mono"
            />
            <p className="text-[10px] text-foreground/30">支持变量: {'{season}'}, {'{scene}'}, {'{weather}'}, {'{angle}'} 等，运行时自动替换</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!name || !content || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
