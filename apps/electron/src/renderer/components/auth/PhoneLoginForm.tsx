import { useEffect, useState } from 'react'
import { ArrowLeft, Loader2, Smartphone } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ApiError, api, setAuthToken } from '@/lib/api'
import type { CurrentUser } from '@/atoms/auth'
import { OtpInput } from './OtpInput'

interface Props {
  onSuccess: (user: CurrentUser) => void
}

const PHONE_REGEX = /^1[3-9]\d{9}$/
const RESEND_COOLDOWN_SEC = 60
type Step = 'phone' | 'code'

/** 把手机号格式化成 138 1234 5678（仅显示用） */
function formatPhone(p: string) {
  const d = p.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 7) return `${d.slice(0, 3)} ${d.slice(3)}`
  return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`
}

export function PhoneLoginForm({ onSuccess }: Props) {
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  const phoneValid = PHONE_REGEX.test(phone)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const handleSend = async () => {
    if (!phoneValid) {
      toast.error('请输入正确的手机号')
      return
    }
    setSending(true)
    try {
      const res = await api.auth.sendSms(phone)
      toast.success(`验证码已发送，${Math.round(res.ttl_sec / 60)} 分钟内有效`)
      setCooldown(RESEND_COOLDOWN_SEC)
      setStep('code')
      setCode('')
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 429) {
        const detail = (e.body as any)?.detail || e.body
        const retry = detail?.retry_after || RESEND_COOLDOWN_SEC
        setCooldown(retry)
        setStep('code')
        toast.error(detail?.message || `请 ${retry} 秒后再试`)
      } else {
        const detail = (e as ApiError).body
        const msg = (detail as any)?.detail?.message || (e as Error).message
        toast.error(`发送失败：${msg}`)
      }
    } finally {
      setSending(false)
    }
  }

  const handleVerify = async (codeToVerify: string = code) => {
    if (!phoneValid || codeToVerify.length !== 6) return
    setVerifying(true)
    try {
      const result = await api.auth.verifySms(phone, codeToVerify)
      await setAuthToken(result.token)
      // v0.1 → v0.2 升级路径：第一个登录的人接管了本机所有项目数据。
      // 给一个明确提示，避免用户疑惑「我什么都没做怎么有这么多数据」。
      const claimed = (result as any).claimed_orphan_data
      if (claimed && claimed.projects > 0) {
        toast.success(
          `欢迎，已自动接管本机 ${claimed.projects} 个项目`,
          { description: '你是这台机器升级后的首位登录者，自动成为组织所有者' },
        )
      } else {
        toast.success(`欢迎，${result.user.display_name || result.user.phone}`)
      }
      onSuccess(result.user)
    } catch (e: unknown) {
      const detail = (e as ApiError).body
      const msg = (detail as any)?.detail?.message || (e as Error).message
      toast.error(msg || '验证码错误')
      setCode('')
    } finally {
      setVerifying(false)
    }
  }

  // ── Step 1: 输手机号 ───────────────────────────────────────────────
  if (step === 'phone') {
    return (
      <div className="space-y-3.5">
        {/* 手机号输入：左前缀 +86 + 图标 + 数字 */}
        <div className="flex items-stretch gap-2">
          <span className="inline-flex items-center justify-center w-[60px] rounded-xl border border-foreground/10 bg-foreground/[0.025] text-[12.5px] font-medium text-foreground/60 tabular-nums">
            +86
          </span>
          <div className="relative flex-1">
            <Smartphone
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40"
            />
            <input
              type="tel"
              value={formatPhone(phone)}
              placeholder="138 1234 5678"
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              onKeyDown={(e) => { if (e.key === 'Enter' && phoneValid) handleSend() }}
              className="h-11 w-full rounded-xl border border-foreground/10 bg-foreground/[0.025] pl-9 pr-3 text-[14px] tabular-nums tracking-wide text-foreground/85 placeholder:text-foreground/30 outline-none transition-all focus:border-foreground/20 focus:bg-background focus:ring-2 focus:ring-accent/15 dark:bg-foreground/[0.04] dark:focus:bg-foreground/[0.06]"
              disabled={sending}
              autoFocus
            />
          </div>
        </div>

        {/* 主按钮 — 深色填充 */}
        <Button
          onClick={handleSend}
          disabled={!phoneValid || sending}
          className="h-11 w-full rounded-xl bg-foreground text-background text-[13.5px] font-medium hover:bg-foreground/90 disabled:bg-foreground/20 disabled:text-foreground/40"
        >
          {sending ? (
            <><Loader2 size={14} className="animate-spin mr-1.5" />正在发送验证码…</>
          ) : (
            '获取验证码'
          )}
        </Button>

        {/* 副信息：登录即注册说明 */}
        <p className="text-center text-[11px] leading-relaxed text-foreground/45">
          首次输入将自动创建账号 · 无需注册流程
        </p>
      </div>
    )
  }

  // ── Step 2: 输验证码 ───────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* 顶部条：返回 + 当前手机号 */}
      <div className="flex items-center justify-between rounded-xl border border-foreground/8 bg-foreground/[0.02] px-3 py-2">
        <button
          type="button"
          onClick={() => { setStep('phone'); setCode('') }}
          className="inline-flex items-center gap-1 text-[11.5px] text-foreground/55 transition-colors hover:text-foreground/85"
        >
          <ArrowLeft size={12} />
          修改手机号
        </button>
        <span className="text-[11.5px] tabular-nums text-foreground/70">
          +86 {formatPhone(phone)}
        </span>
      </div>

      {/* 验证码 OTP */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label className="text-[12px] text-foreground/65">短信验证码</label>
          <span className="text-[10.5px] text-foreground/40">5 分钟内有效</span>
        </div>
        <OtpInput
          value={code}
          onChange={setCode}
          onComplete={(v) => handleVerify(v)}
          disabled={verifying}
          autoFocus
        />
      </div>

      {/* 主按钮 */}
      <Button
        onClick={() => handleVerify()}
        disabled={code.length !== 6 || verifying}
        className="h-11 w-full rounded-xl bg-foreground text-background text-[13.5px] font-medium hover:bg-foreground/90 disabled:bg-foreground/20 disabled:text-foreground/40"
      >
        {verifying ? (
          <><Loader2 size={14} className="animate-spin mr-1.5" />正在登录…</>
        ) : (
          '立即开始'
        )}
      </Button>

      {/* 重发链接 / 倒计时 */}
      <div className="flex items-center justify-center text-[11.5px]">
        {cooldown > 0 ? (
          <span className="tabular-nums text-foreground/45">
            <span className="text-foreground/65">{cooldown}s</span> 后可重新发送
          </span>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={sending}
            className="text-accent transition-colors hover:text-accent/80 disabled:opacity-50"
          >
            {sending ? '正在重发…' : '重新发送验证码'}
          </button>
        )}
      </div>
    </div>
  )
}
