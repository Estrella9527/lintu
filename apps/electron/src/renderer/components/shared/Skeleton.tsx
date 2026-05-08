import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

/**
 * 统一 Skeleton 组件 + 三种语义化预设：
 *   - <Skeleton.StatCard />    — 仪表盘的统计卡片
 *   - <Skeleton.ImageCard />   — 资产库的图片卡片
 *   - <Skeleton.TableRow />    — 列表 / 表格的行
 *
 * 使用守则（详见 docs / CLAUDE.md）：
 *   - 列表 / 卡片网格的初次加载 → Skeleton（首屏 2-3 秒可见）
 *   - 单次操作（保存 / 测试连接 / 提交） → Spinner / Loader2
 *   - 二次进入同模块 → 不闪屏（TanStack Query 的 isFetching ≠ isLoading）
 */
function SkeletonRoot({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-md bg-foreground/[0.04] animate-pulse', className)}
      {...rest}
    />
  )
}

function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-lg border border-foreground/5 p-4 space-y-3', className)}>
      <div className="flex items-center justify-between">
        <SkeletonRoot className="h-3 w-16" />
        <SkeletonRoot className="h-3 w-3 rounded-full" />
      </div>
      <SkeletonRoot className="h-7 w-20" />
      <SkeletonRoot className="h-2 w-12" />
    </div>
  )
}

function ImageCardSkeleton({ className, aspect = '4/3' }: { className?: string; aspect?: string }) {
  return (
    <SkeletonRoot
      className={cn('w-full rounded-md', className)}
      style={{ aspectRatio: aspect }}
    />
  )
}

function TableRowSkeleton({ className, cols = 4 }: { className?: string; cols?: number }) {
  return (
    <div className={cn('flex items-center gap-3 py-2', className)}>
      {Array.from({ length: cols }).map((_, i) => (
        <SkeletonRoot
          key={i}
          className={cn('h-3', i === 0 ? 'w-32' : 'flex-1')}
        />
      ))}
    </div>
  )
}

function ImageGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <ImageCardSkeleton key={i} />
      ))}
    </div>
  )
}

export const Skeleton = Object.assign(SkeletonRoot, {
  StatCard: StatCardSkeleton,
  ImageCard: ImageCardSkeleton,
  TableRow: TableRowSkeleton,
  ImageGrid: ImageGridSkeleton,
})
