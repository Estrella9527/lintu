import { useEffect } from 'react'
import { useAtom } from 'jotai'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { activeProjectIdAtom } from '@/atoms/project'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { Plus } from 'lucide-react'
import { useState } from 'react'

interface Project {
  id: string
  name: string
  originals_path: string
}

export function ProjectSelector() {
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useAtom(activeProjectIdAtom)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDir, setNewDir] = useState<string | null>(null)

  const { data: projects } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => fetch('http://localhost:7879/api/projects').then((r) => r.json()),
  })

  // Auto-select first project if none active
  useEffect(() => {
    if (!activeId && projects && projects.length > 0) {
      setActiveId(projects[0].id)
    }
  }, [activeId, projects, setActiveId])

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!newName || !newDir) throw new Error('请填写项目名称和目录')
      const res = await fetch('http://localhost:7879/api/projects', {
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

  return (
    <>
      <div className="flex items-center gap-1 px-2 mb-2">
        <Select value={activeId || ''} onValueChange={setActiveId}>
          <SelectTrigger className="h-7 text-[12px] flex-1 border-foreground/5">
            <SelectValue placeholder="选择项目" />
          </SelectTrigger>
          <SelectContent>
            {projects?.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-[12px]">
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => setShowCreate(true)}
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
    </>
  )
}
