import { useAtom } from 'jotai'
import { themeAtom, type ThemeMode } from '@/atoms/theme'
import { cn } from '@/lib/utils'
import { Sun, Moon, Monitor } from 'lucide-react'

const THEMES: { value: ThemeMode; label: string; icon: React.ElementType }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

export function GeneralTab() {
  const [theme, setTheme] = useAtom(themeAtom)

  return (
    <div className="space-y-6 max-w-2xl">
      <section>
        <h3 className="text-[13px] font-medium text-foreground/80 mb-3">数据目录</h3>
        <div className="rounded-md border border-foreground/5 p-3 text-[13px] text-foreground/40">
          ~/lintu-data
        </div>
      </section>

      <section>
        <h3 className="text-[13px] font-medium text-foreground/80 mb-3">主题</h3>
        <div className="flex gap-2">
          {THEMES.map((t) => {
            const Icon = t.icon
            const active = theme === t.value
            return (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-[13px] border transition-colors',
                  active
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-foreground/5 text-foreground/50 hover:bg-foreground/[0.03]',
                )}
              >
                <Icon size={14} />
                {t.label}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
