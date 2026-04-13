import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface DirectorySelectorProps {
  value: string | null
  onChange: (path: string) => void
  label?: string
}

export function DirectorySelector({ value, onChange, label = '选择目录' }: DirectorySelectorProps) {
  const handleSelect = async () => {
    const path = await window.electronAPI.selectDirectory()
    if (path) onChange(path)
  }

  return (
    <div className="space-y-1.5">
      <label className="text-[12px] text-foreground/50">{label}</label>
      <div className="flex gap-2">
        <div className="flex-1 px-3 py-2 rounded-md border border-foreground/10 bg-foreground/[0.02] text-[13px] text-foreground/70 truncate min-h-[36px] flex items-center">
          {value || '未选择'}
        </div>
        <Button variant="outline" size="sm" onClick={handleSelect} className="shrink-0">
          <FolderOpen size={14} className="mr-1.5" />
          浏览
        </Button>
      </div>
    </div>
  )
}
