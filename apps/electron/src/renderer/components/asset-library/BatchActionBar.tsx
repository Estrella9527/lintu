import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Download, Trash2, CheckCircle, XCircle, X } from 'lucide-react'

interface BatchActionBarProps {
  selectedCount: number
  selectedIds: Set<string>
  onClear: () => void
}

export function BatchActionBar({ selectedCount, selectedIds, onClear }: BatchActionBarProps) {
  const queryClient = useQueryClient()
  const ids = Array.from(selectedIds)

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetch('http://localhost:7879/api/images/batch/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids }),
      }).then((r) => r.json()),
    onSuccess: (data) => {
      toast.success(`已删除 ${data.deleted} 张图片`)
      onClear()
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: () => toast.error('删除失败'),
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      fetch(`http://localhost:7879/api/images/batch/update-status?status=${status}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_ids: ids }),
      }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('状态已更新')
      onClear()
      queryClient.invalidateQueries({ queryKey: ['images'] })
    },
  })

  const handleDownload = async () => {
    if (ids.length === 1) {
      // Single file: show save dialog
      const id = ids[0]
      const detailRes = await fetch(`http://localhost:7879/api/images/${id}`)
      const detail = await detailRes.json()
      const url = `http://localhost:7879/api/images/${id}/download`
      const saved = await window.electronAPI.downloadFile(url, detail.file_name || `${id}.jpg`)
      if (saved) toast.success(`已保存到 ${saved}`)
    } else {
      // Multiple: ask for directory, then save all
      const dir = await window.electronAPI.selectDirectory()
      if (!dir) return
      let saved = 0
      for (const id of ids) {
        try {
          const res = await fetch(`http://localhost:7879/api/images/${id}/download`)
          const blob = await res.blob()
          const detailRes = await fetch(`http://localhost:7879/api/images/${id}`)
          const detail = await detailRes.json()
          const filename = detail.file_name || `${id}.jpg`
          // Use IPC to save to chosen directory
          const url = `http://localhost:7879/api/images/${id}/download`
          // For batch, we write directly via a temporary approach
          await window.electronAPI.downloadFile(url, `${dir}/${filename}`)
          saved++
        } catch {}
      }
      toast.success(`已保存 ${saved} 张图片到 ${dir}`)
    }
  }

  if (selectedCount === 0) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 mb-2 rounded-lg bg-accent/5 border border-accent/20">
      <span className="text-[13px] text-accent font-medium mr-2">
        已选 {selectedCount} 张
      </span>

      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={handleDownload}>
        <Download size={12} className="mr-1" /> 下载
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => statusMutation.mutate('passed')}>
        <CheckCircle size={12} className="mr-1" /> 标记通过
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => statusMutation.mutate('rejected')}>
        <XCircle size={12} className="mr-1" /> 标记淘汰
      </Button>

      <Button
        variant="outline" size="sm"
        className="h-7 text-[12px] text-destructive border-destructive/30 hover:bg-destructive/10"
        onClick={() => {
          if (confirm(`确定删除 ${selectedCount} 张图片？此操作不可撤销。`)) deleteMutation.mutate()
        }}
        disabled={deleteMutation.isPending}
      >
        <Trash2 size={12} className="mr-1" /> 删除
      </Button>

      <div className="flex-1" />

      <Button variant="ghost" size="sm" className="h-7 text-[12px] text-foreground/40" onClick={onClear}>
        <X size={12} className="mr-1" /> 取消选择
      </Button>
    </div>
  )
}
