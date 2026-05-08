import { Sparkles, Wrench, Bug } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { type ReleaseEntry, type ReleaseSection, RELEASES } from '@/data/release-notes'

interface ReleaseNotesModalProps {
  open: boolean
  onClose: () => void
  /** 要展示的 releases；不传则展示全部 RELEASES */
  releases?: ReleaseEntry[]
  /** 标题区文案；区分「升级后首启提示」和「关于页历史浏览」两种语境 */
  variant?: 'first-launch' | 'browse'
}

const SECTION_META: Record<ReleaseSection['kind'], { label: string; icon: typeof Sparkles; tone: string }> = {
  added:    { label: '新增', icon: Sparkles, tone: 'text-emerald-500' },
  improved: { label: '优化', icon: Wrench,   tone: 'text-blue-500' },
  fixed:    { label: '修复', icon: Bug,      tone: 'text-amber-500' },
}

export function ReleaseNotesModal({
  open,
  onClose,
  releases,
  variant = 'browse',
}: ReleaseNotesModalProps) {
  const list = releases ?? RELEASES
  const isFirstLaunch = variant === 'first-launch'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-[560px] gap-0">
        <DialogHeader className="pb-3">
          <DialogTitle>
            {isFirstLaunch ? '本次更新内容' : '更新历史'}
          </DialogTitle>
          <DialogDescription>
            {isFirstLaunch
              ? `灵图已升级到 v${list[0]?.version ?? ''}，以下是这次更新的主要内容。`
              : '按版本倒序展示历次发版。'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[420px] pr-3 -mr-3">
          <div className="space-y-5">
            {list.map((release, idx) => (
              <ReleaseBlock key={release.version} release={release} dim={idx > 0 && isFirstLaunch} />
            ))}
          </div>
        </ScrollArea>

        <div className="pt-4 mt-1 flex justify-end border-t border-foreground/5">
          <Button size="sm" onClick={onClose}>
            {isFirstLaunch ? '知道了' : '关闭'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReleaseBlock({ release, dim }: { release: ReleaseEntry; dim: boolean }) {
  return (
    <section className={cn(dim && 'opacity-70')}>
      <header className="flex items-baseline gap-2 mb-2">
        <h3 className="text-[14px] font-semibold text-foreground/85">v{release.version}</h3>
        <span className="text-[11px] text-foreground/45">{release.date}</span>
      </header>
      {release.highlights && (
        <p className="text-[12.5px] text-foreground/65 leading-relaxed mb-3">
          {release.highlights}
        </p>
      )}
      <div className="space-y-3">
        {release.sections.map((s) => {
          const meta = SECTION_META[s.kind]
          const Icon = meta.icon
          return (
            <div key={s.kind}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon size={12} className={meta.tone} strokeWidth={2} />
                <span className="text-[11.5px] font-medium text-foreground/70">{meta.label}</span>
              </div>
              <ul className="space-y-1 pl-[18px]">
                {s.items.map((item, i) => (
                  <li
                    key={i}
                    className="text-[12.5px] leading-relaxed text-foreground/75 list-disc marker:text-foreground/30"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
