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
    for (const id of ids) {
      const url = `http://localhost:7879/api/images/${id}/download`
      const a = document.createElement('a')
      a.href = url
      a.download = ''
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Small delay between downloads
      await new Promise((r) => setTimeout(r, 200))
    }
    toast.success(`已开始下载 ${ids.length} 张图片`)
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

      <Button
        variant="outline" size="sm" className="h-7 text-[12px]"
        onClick={() => statusMutation.mutate('passed')}
      >
        <CheckCircle size={12} className="mr-1" /> 标记通过
      </Button>

      <Button
        variant="outline" size="sm" className="h-7 text-[12px]"
        onClick={() => statusMutation.mutate('rejected')}
      >
        <XCircle size={12} className="mr-1" /> 标记淘汰
      </Button>

      <Button
        variant="outline" size="sm" className="h-7 text-[12px] text-destructive border-destructive/30 hover:bg-destructive/10"
        onClick={() => {
          if (confirm(`确定删除 ${selectedCount} 张图片？此操作不可撤销。`)) {
            deleteMutation.mutate()
          }
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
