import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Sun, Moon, Monitor } from 'lucide-react'

import { themeAtom, type ThemeMode } from '@/atoms/theme'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { InfoHint } from '@/components/shared/InfoHint'

const THEMES: { value: ThemeMode; label: string; icon: React.ElementType }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
]

type OversizePolicy = 'fail' | 'shrink'

export function GeneralTab() {
  const [theme, setTheme] = useAtom(themeAtom)
  const queryClient = useQueryClient()

  const { data: config } = useQuery<Record<string, string | number>>({
    queryKey: ['config'],
    queryFn: () => api.config.get() as any,
  })

  const [maxMb, setMaxMb] = useState<string>('')
  const [policy, setPolicy] = useState<OversizePolicy>('fail')
  const [pullEnabled, setPullEnabled] = useState(false)

  // 多设备同步状态(开关回显 + 上次同步时间);开着时 10s 轮询刷新时间
  const { data: pullStatus } = useQuery({
    queryKey: ['cloud-pull-status'],
    queryFn: () => api.config.cloudPullStatus(),
    refetchInterval: 10_000,
  })

  useEffect(() => {
    if (!config) return
    const bytes = Number(config['upload_max_bytes'] ?? 0)
    setMaxMb(bytes > 0 ? String(Math.round(bytes / (1024 * 1024))) : '0')
    const p = String(config['upload_oversize_policy'] || 'fail').toLowerCase()
    setPolicy(p === 'shrink' ? 'shrink' : 'fail')
    const cp = config['cloud_pull_enabled'] as unknown
    setPullEnabled(cp === true || String(cp).toLowerCase() === 'true' || String(cp) === '1')
  }, [config])

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, any>) => api.config.update(payload),
    onSuccess: () => {
      toast.success('已保存上传策略')
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
    onError: (e: any) => toast.error(`保存失败：${e?.message || e}`),
  })

  const saveUploadPolicy = () => {
    const mb = Math.max(0, Math.floor(Number(maxMb) || 0))
    saveMutation.mutate({
      upload_max_bytes: mb * 1024 * 1024,
      upload_oversize_policy: policy,
    })
  }

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

      <section>
        <div className="flex items-center gap-1.5 mb-3">
          <h3 className="text-[13px] font-medium text-foreground/80">生成上传策略</h3>
          <InfoHint text={
            'AI 工坊调用 API 时默认原字节透传，绝不二次编码。\n' +
            '这里设定一个保护阈值：当种子图字节数超过限制时，按下方策略处理（防止 relay 413/422 拒收）。'
          } />
        </div>
        <div className="grid grid-cols-[140px_1fr] gap-3 items-center text-[12.5px]">
          <label className="text-foreground/65 inline-flex items-center gap-1">
            单图上限 (MB)
            <InfoHint text="0 = 不限制" />
          </label>
          <Input
            type="number"
            min="0"
            step="1"
            value={maxMb}
            onChange={(e) => setMaxMb(e.target.value)}
            className="w-28 h-8"
          />

          <label className="text-foreground/65">超阈值时</label>
          <div className="flex gap-2">
            {([
              { v: 'fail' as const, label: '直接失败', desc: '保留任务为失败状态，提示用户处理源图' },
              { v: 'shrink' as const, label: '自动缩小', desc: '在内存中渐次降采样直到符合限制（有损）' },
            ]).map((opt) => (
              <button
                key={opt.v}
                onClick={() => setPolicy(opt.v)}
                title={opt.desc}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-2 rounded-md border text-[12px] transition-colors',
                  policy === opt.v
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-foreground/8 text-foreground/55 hover:bg-foreground/[0.03]',
                )}
              >
                {opt.label}
                <InfoHint text={opt.desc} size={11} />
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <Button size="sm" onClick={saveUploadPolicy} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? '保存中…' : '保存上传策略'}
          </Button>
        </div>
      </section>

      <section>
        <div className="flex items-center gap-1.5 mb-3">
          <h3 className="text-[13px] font-medium text-foreground/80">多设备同步</h3>
          <InfoHint text={
            '打开后,本机每 30 秒从云端拉回其他电脑上「已上传到图库」的图片、标签和上下架状态。\n' +
            '本机上传图库后的发布始终会自动同步给其他电脑,此开关只控制"收不收别人的"。\n' +
            '打标用于检索与匹配增强，不会阻塞图库同步；UGC 是否可用仍由“上架”决定。'
          } />
        </div>
        <div className="rounded-md border border-foreground/5 p-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12.5px] text-foreground/75">
              同步其他电脑已发布的图片与标签
            </p>
            <p className="text-[11px] text-foreground/40 mt-0.5">
              {pullStatus?.enabled
                ? pullStatus?.last_at
                  ? `已开启 · 上次同步 ${new Date(pullStatus.last_at + 'Z').toLocaleString()}`
                  : '已开启 · 等待首次同步(最长 30 秒)'
                : '未开启 · 本机看不到其他电脑已上传图库的图片、标签与上架状态'}
            </p>
          </div>
          <Switch
            checked={!!pullEnabled}
            onCheckedChange={async (v) => {
              setPullEnabled(v)
              try {
                await api.config.update({ cloud_pull_enabled: v })
                toast.success(v ? '多设备同步已开启,30 秒内开始首次同步' : '多设备同步已关闭')
                queryClient.invalidateQueries({ queryKey: ['config'] })
                queryClient.invalidateQueries({ queryKey: ['cloud-pull-status'] })
              } catch (e: any) {
                setPullEnabled(!v)
                toast.error(`保存失败:${e?.message || e}`)
              }
            }}
          />
        </div>
      </section>
    </div>
  )
}
