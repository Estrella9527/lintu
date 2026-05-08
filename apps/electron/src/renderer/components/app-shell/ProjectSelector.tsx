import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { activeProjectIdAtom } from '@/atoms/project'
import { apiFetchRaw } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { DirectorySelector } from '@/components/pipeline/DirectorySelector'
import { Check, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Project {
  id: string
  name: string
  originals_path: string
  color: string | null
}

// Curated palette — picked to read well on both light and dark sidebar.
// First entry (transparent + slash) means "no color".
const COLOR_PALETTE: { value: string | null; label: string }[] = [
  { value: null, label: '默认' },
  { value: '#7c3aed', label: '紫' },
  { value: '#2563eb', label: '蓝' },
  { value: '#0891b2', label: '青' },
  { value: '#16a34a', label: '绿' },
  { value: '#ca8a04', label: '黄' },
  { value: '#ea580c', label: '橙' },
  { value: '#dc2626', label: '红' },
  { value: '#db2777', label: '粉' },
  { value: '#64748b', label: '灰' },
]

export function ProjectSelector() {
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useAtom(activeProjectIdAtom)
  const [showCreate, setShowCreate] = useState(false)
  const [showManage, setShowManage] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDir, setNewDir] = useState<string | null>(null)

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => apiFetchRaw('/projects').then((r) => r.json()),
  })

  // Auto-select first project if active is missing OR points to a deleted project.
  // 后者发生在：项目被管理员删除 / 数据库迁移把脏数据清掉 / 用户切到没权限的工作区。
  // 不做这个兜底的话，stale localStorage 会让 ProjectSelector 一直显示「选择项目」
  // 但其它页面把 stale id 拼进 URL → 后端返回空 → UI 看似"什么都没有"。
  useEffect(() => {
    if (!projects || projects.length === 0) return
    const stillExists = activeId && projects.some((p) => p.id === activeId)
    if (!stillExists) setActiveId(projects[0].id)
  }, [activeId, projects, setActiveId])

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!newName || !newDir) throw new Error('请填写项目名称和目录')
      const res = await apiFetchRaw('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, originals_path: newDir, workspace_path: newDir }),
      })
      return res.json()
    },
    onSuccess: (project: Project) => {
      setActiveId(project.id)
      setShowCreate(false)
      setNewName('')
      setNewDir(null)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(`项目「${project.name}」已创建`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const activeProject = projects?.find((p) => p.id === activeId) || null

  return (
    <>
      <div className="flex items-center gap-1 px-2 mb-2 min-w-0">
        <Select value={activeId || ''} onValueChange={setActiveId}>
          <SelectTrigger
            className="h-7 text-[12px] flex-1 min-w-0 border-foreground/5"
            title={activeProject?.name}
          >
            <SelectValue placeholder="选择项目">
              {activeProject && (
                <span className="flex items-center gap-1.5 min-w-0 max-w-full">
                  <ColorDot color={activeProject.color} />
                  <span className="truncate min-w-0">{activeProject.name}</span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-w-[280px]">
            {projects?.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-[12px]">
                <span className="flex items-center gap-1.5 max-w-full">
                  <ColorDot color={p.color} />
                  <span className="truncate">{p.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => setShowManage(true)}
          title="管理项目"
        >
          <Settings2 size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => setShowCreate(true)}
          title="新建项目"
        >
          <Plus size={14} />
        </Button>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px]">新建项目</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-[12px] text-foreground/50">项目名称</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例如：示例景区B景区"
                className="h-8 text-[13px]"
              />
            </div>
            <DirectorySelector value={newDir} onChange={setNewDir} label="图片目录" />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!newName || !newDir || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManageProjectsDialog
        open={showManage}
        onClose={() => setShowManage(false)}
        projects={projects || []}
        activeId={activeId}
        onActiveDeleted={(remaining) => {
          // If we just deleted the active project, fall back to whichever
          // is left (or null if none).
          setActiveId(remaining[0]?.id || '')
        }}
      />
    </>
  )
}


function ColorDot({ color }: { color: string | null }) {
  if (!color) {
    return (
      <span
        className="inline-block h-2.5 w-2.5 rounded-full border border-foreground/15 shrink-0"
        aria-hidden
      />
    )
  }
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
}


function ManageProjectsDialog({
  open, onClose, projects, activeId, onActiveDeleted,
}: {
  open: boolean
  onClose: () => void
  projects: Project[]
  activeId: string | null
  onActiveDeleted: (remaining: Project[]) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px]">管理项目</DialogTitle>
        </DialogHeader>
        <div className="space-y-1 py-1">
          {projects.length === 0 ? (
            <div className="text-center py-6 text-[12px] text-foreground/40">还没有项目</div>
          ) : (
            projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                isActive={p.id === activeId}
                onDeleted={() => {
                  if (p.id === activeId) {
                    onActiveDeleted(projects.filter((x) => x.id !== p.id))
                  }
                }}
              />
            ))
          )}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


function ProjectRow({
  project, isActive, onDeleted,
}: {
  project: Project
  isActive: boolean
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(project.name)

  const saveName = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiFetchRaw(`/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: () => {
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('已重命名')
    },
    onError: (e: Error) => toast.error(`重命名失败：${e.message}`),
  })

  const saveColor = useMutation({
    mutationFn: async (color: string | null) => {
      const res = await apiFetchRaw(`/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: color ?? '' }),
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
    onError: (e: Error) => toast.error(`颜色保存失败：${e.message}`),
  })

  const deleteProject = useMutation({
    mutationFn: async () => {
      // Fetch image count for the confirm dialog so the user knows the
      // blast radius. Cheap query.
      const sres = await apiFetchRaw(`/projects/${project.id}/stats`)
      const stats = sres.ok ? await sres.json() : { image_count: 0 }
      const count = stats.image_count ?? 0
      const ok = window.confirm(
        `删除项目「${project.name}」？\n\n` +
        `数据库里 ${count.toLocaleString()} 张图片记录、所有标签、衍生关系都会被清除。\n` +
        `磁盘上的图片文件不会被删除（位于 ${project.originals_path}）。\n\n` +
        `此操作不可撤销。`
      )
      if (!ok) throw new Error('已取消')
      const res = await apiFetchRaw(`/projects/${project.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      onDeleted()
      toast.success(`项目「${project.name}」已删除`)
    },
    onError: (e: Error) => {
      if (e.message !== '已取消') toast.error(`删除失败：${e.message}`)
    },
  })

  return (
    <div className={cn(
      'flex items-center gap-2 px-2 py-2 rounded-md border',
      isActive ? 'border-accent/40 bg-accent/[0.04]' : 'border-foreground/8',
    )}>
      <ColorPickerPopover
        value={project.color}
        onChange={(c) => saveColor.mutate(c)}
        disabled={saveColor.isPending}
      />
      {editing ? (
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveName.mutate(draftName.trim())
            else if (e.key === 'Escape') { setEditing(false); setDraftName(project.name) }
          }}
          onBlur={() => {
            const next = draftName.trim()
            if (next && next !== project.name) saveName.mutate(next)
            else { setEditing(false); setDraftName(project.name) }
          }}
          autoFocus
          className="h-7 text-[12.5px] flex-1"
        />
      ) : (
        <span
          className="text-[12.5px] text-foreground/85 flex-1 truncate cursor-text"
          onDoubleClick={() => setEditing(true)}
          title="双击重命名"
        >
          {project.name}
          {isActive && (
            <span className="ml-2 text-[10px] text-accent">当前</span>
          )}
        </span>
      )}
      {!editing && (
        <Button
          variant="ghost" size="sm"
          className="h-6 w-6 p-0 text-foreground/40 hover:text-foreground/70"
          onClick={() => setEditing(true)}
          title="重命名"
        >
          <Pencil size={11} />
        </Button>
      )}
      <Button
        variant="ghost" size="sm"
        className="h-6 w-6 p-0 text-foreground/40 hover:text-destructive"
        onClick={() => deleteProject.mutate()}
        disabled={deleteProject.isPending}
        title="删除项目"
      >
        <Trash2 size={11} />
      </Button>
    </div>
  )
}


function ColorPickerPopover({
  value, onChange, disabled,
}: {
  value: string | null
  onChange: (color: string | null) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="shrink-0 h-6 w-6 rounded-full border border-foreground/15 flex items-center justify-center hover:ring-2 hover:ring-foreground/15 transition disabled:opacity-50"
          style={value ? { backgroundColor: value, borderColor: 'transparent' } : undefined}
          title="选择颜色"
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5">
          {COLOR_PALETTE.map((opt) => {
            const selected = (opt.value ?? '') === (value ?? '')
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false) }}
                className={cn(
                  'h-7 w-7 rounded-full border flex items-center justify-center transition',
                  selected ? 'ring-2 ring-foreground/40 border-transparent' : 'border-foreground/15 hover:ring-2 hover:ring-foreground/15',
                )}
                style={opt.value ? { backgroundColor: opt.value, borderColor: 'transparent' } : undefined}
                title={opt.label}
              >
                {selected && <Check size={11} className={opt.value ? 'text-white' : 'text-foreground/60'} />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
