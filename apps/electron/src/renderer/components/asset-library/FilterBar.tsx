import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'passed', label: '已通过' },
  { value: 'rejected', label: '已淘汰' },
  { value: 'pending', label: '待处理' },
]

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'original', label: '原图' },
  { value: 'generated', label: '全部生成图' },
  { value: 'crop', label: '裁剪' },
  { value: 'upscale', label: '超分' },
  { value: 'outpaint', label: '画布扩展' },
  { value: 'seasonal', label: '季节变换' },
  { value: 'style', label: '风格变换' },
  { value: 'inpaint', label: '局部编辑' },
  { value: 'marketing', label: '营销素材' },
]

export interface FilterState {
  search: string
  status: string
  source: string
}

interface FilterBarProps {
  filter: FilterState
  onChange: (filter: FilterState) => void
}

export function FilterBar({ filter, onChange }: FilterBarProps) {
  const hasFilters = filter.search || filter.status !== 'all' || filter.source !== 'all'

  return (
    <div className="flex items-center gap-2 mb-3">
      <Input
        placeholder="搜索文件名..."
        value={filter.search}
        onChange={(e) => onChange({ ...filter, search: e.target.value })}
        className="w-44 h-8 text-[13px]"
      />
      <Select value={filter.status} onValueChange={(v) => onChange({ ...filter, status: v })}>
        <SelectTrigger className="w-28 h-8 text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filter.source} onValueChange={(v) => onChange({ ...filter, source: v })}>
        <SelectTrigger className="w-32 h-8 text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SOURCE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters && (
        <Button
          variant="ghost" size="sm"
          className="h-8 px-2 text-[12px] text-foreground/50"
          onClick={() => onChange({ search: '', status: 'all', source: 'all' })}
        >
          <X size={12} className="mr-1" /> 清除
        </Button>
      )}
    </div>
  )
}
