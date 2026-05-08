import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface EmptyStateAction {
  label: string
  onClick: () => void
  variant?: 'default' | 'outline' | 'ghost'
}

interface EmptyStateProps {
  /** Lucide icon component（不强制 — 不传时空白处用文字 + 视觉留白也够） */
  icon?: LucideIcon
  /** 主文案（中文，约 8-15 字）— 例：「还没有图片」 */
  title: string
  /** 副文案（中文，1-2 句解释下一步该做什么） */
  description?: string
  /** 主 CTA — 引导用户进入下一动作 */
  action?: EmptyStateAction
  /** 次 CTA — 例如「查看示例」 */
  secondaryAction?: EmptyStateAction
  /** 额外节点（例如示例查询芯片）插在按钮上方 */
  children?: ReactNode
  /** 紧凑模式：在卡片内部 / 列表里使用，去掉大幅留白 */
  compact?: boolean
  className?: string
}

/**
 * 统一空态组件。设计目标：
 *   1. 代替散落各处的 `<div>暂无...</div>` 文本
 *   2. 始终引导一个明确的下一步（CTA）— 用户不应该在空白处不知所措
 *   3. 视觉规范：图标 24×24，文字 14px / 12px，CTA 主按钮，整体居中
 *
 * 用法：
 *   <EmptyState
 *     icon={ImageOff}
 *     title="资产库还没有图片"
 *     description="跑一次流水线扫描你的图片目录后这里就有内容了"
 *     action={{ label: '去流水线', onClick: () => navigate('pipeline') }}
 *   />
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-6 px-4 gap-2' : 'py-12 px-6 gap-3',
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            'rounded-full bg-foreground/[0.04] flex items-center justify-center text-foreground/35',
            compact ? 'h-8 w-8 mb-1' : 'h-12 w-12 mb-2',
          )}
        >
          <Icon size={compact ? 16 : 24} strokeWidth={1.5} />
        </div>
      )}
      <h3
        className={cn(
          'font-medium text-foreground/75',
          compact ? 'text-[12.5px]' : 'text-[14px]',
        )}
      >
        {title}
      </h3>
      {description && (
        <p
          className={cn(
            'text-foreground/45 max-w-[360px] leading-relaxed',
            compact ? 'text-[11.5px]' : 'text-[12.5px]',
          )}
        >
          {description}
        </p>
      )}
      {children && <div className="mt-1">{children}</div>}
      {(action || secondaryAction) && (
        <div className={cn('flex items-center gap-2', compact ? 'mt-1' : 'mt-2')}>
          {action && (
            <Button size={compact ? 'sm' : 'default'} variant={action.variant ?? 'default'} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button
              size={compact ? 'sm' : 'default'}
              variant={secondaryAction.variant ?? 'outline'}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
