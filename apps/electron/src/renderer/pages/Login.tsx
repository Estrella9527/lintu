import type { CurrentUser } from '@/atoms/auth'
import { PhoneLoginForm } from '@/components/auth/PhoneLoginForm'
import logoUrl from '@/assets/logo.png'

interface Props {
  onSuccess: (user: CurrentUser) => void
}

export default function LoginPage({ onSuccess }: Props) {
  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* ── 背景：天空蓝渐变 + 浮云光晕 ────────────────────────────── */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          background: `
            linear-gradient(180deg,
              oklch(0.93 0.04 240) 0%,
              oklch(0.96 0.025 230) 35%,
              oklch(0.985 0.01 220) 100%)
          `,
        }}
      />
      {/* 暗模式覆盖层 */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 hidden dark:block"
        style={{
          background: `
            linear-gradient(180deg,
              oklch(0.18 0.03 270) 0%,
              oklch(0.16 0.025 260) 60%,
              oklch(0.13 0.02 255) 100%)
          `,
        }}
      />
      {/* 云感装饰 — 三团柔光 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/4 -z-10 h-[520px] w-[700px] rounded-full opacity-60 blur-3xl dark:opacity-25"
        style={{ background: 'radial-gradient(ellipse, white 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 -left-32 -z-10 h-[420px] w-[700px] rounded-full opacity-70 blur-3xl dark:opacity-20"
        style={{ background: 'radial-gradient(ellipse, white 0%, transparent 70%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-20 -right-20 -z-10 h-[460px] w-[620px] rounded-full opacity-60 blur-3xl dark:opacity-15"
        style={{ background: 'radial-gradient(ellipse, white 0%, transparent 70%)' }}
      />
      {/* 弧形辅助线 — 模仿原图的薄圆环 */}
      <svg
        aria-hidden
        viewBox="0 0 800 800"
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 opacity-30 dark:opacity-15"
      >
        <circle cx="400" cy="400" r="280" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-foreground/40" />
        <circle cx="400" cy="400" r="350" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-foreground/30" />
      </svg>

      {/* ── 左上角 logo ───────────────────────────────────────────── */}
      <header className="absolute left-7 top-6 z-10">
        <img
          src={logoUrl}
          alt="灵图"
          className="h-8 w-8 rounded-lg object-cover shadow-sm ring-1 ring-foreground/8"
        />
      </header>

      {/* ── 中央登录卡片 ─────────────────────────────────────────── */}
      <main className="relative z-0 m-auto w-[420px] max-w-[92vw]">
        <section
          className="relative rounded-3xl border border-white/40 bg-white/55 p-7 pt-12 shadow-[0_2px_4px_rgba(0,0,0,0.04),0_20px_50px_-12px_rgba(0,0,0,0.12)] backdrop-blur-xl dark:border-white/8 dark:bg-foreground/5 dark:shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)]"
        >
          {/* 顶部 logo badge — 浮在卡片顶部边缘 */}
          <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/60 bg-white p-1 shadow-md dark:border-white/10 dark:bg-foreground/10">
              <img
                src={logoUrl}
                alt="灵图"
                className="h-full w-full rounded-xl object-cover"
              />
            </div>
          </div>

          {/* 标题区 */}
          <div className="mb-6 text-center space-y-1.5">
            <h1 className="text-[18px] font-semibold tracking-tight text-foreground/90">
              手机号登录
            </h1>
            <p className="px-3 text-[12px] leading-relaxed text-foreground/55">
              输入手机号即可登录或自动注册，<br />开始使用灵图的 AI 图片生产能力
            </p>
          </div>

          <PhoneLoginForm onSuccess={onSuccess} />
        </section>

        {/* 底部说明 */}
        <footer className="mt-5 space-y-1 text-center">
          <p className="text-[10.5px] text-foreground/45">
            登录即表示同意服务条款 · 登录态 30 天 · 活跃使用每 6 小时自动续期
          </p>
          <p className="text-[10px] text-foreground/35">
            龙蟾科技 · Lintu v0.1.5
          </p>
        </footer>
      </main>
    </div>
  )
}
