import { Badge } from '@/components/ui/badge'

export function PlaceholderStrategy({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-64 rounded-lg border border-dashed border-foreground/10">
      <Badge variant="outline" className="mb-2 text-[11px]">即将支持</Badge>
      <p className="text-[13px] text-foreground/30">{name}策略 — Sprint 4/5 实现</p>
    </div>
  )
}
