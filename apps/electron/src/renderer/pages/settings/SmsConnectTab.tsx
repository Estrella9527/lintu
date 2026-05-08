import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Eye, EyeOff, Loader2, MessageSquare, Send, ShieldCheck, XCircle } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/shared/EmptyState'
import { InfoHint } from '@/components/shared/InfoHint'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 设置 → 短信服务（阿里云）
 *
 * 跟 OSS 连接同款 UI 模式：从 /api/config 读 + 写 sms_* 6 个 key。仅平台超管可见。
 *
 * 为什么不靠 env 变量：客户从 Finder 双击 .app 启动时不会读 ~/.zshrc / ~/.zshenv，
 * 所以生产部署必须在应用内 UI 配，存到本地 config.json。dev 模式可继续用 env 兜底。
 */

interface FieldDef {
  key: string
  label: string
  placeholder: string
  hint?: string
  secret?: boolean
  required?: boolean
}

const FIELDS: FieldDef[] = [
  { key: 'sms_access_key',    label: 'AccessKey ID',  placeholder: 'LTAI5t...', required: true,
    hint: '阿里云 RAM 子账号的 AccessKey ID。强烈不建议用主账号 AK，权限太大。' },
  { key: 'sms_access_secret', label: 'AccessKey Secret', placeholder: '••••••••', secret: true, required: true,
    hint: 'RAM 子账号的 AccessKey Secret。保存后只显示掩码（前 6 位 + ****）。' },
  { key: 'sms_sign_name',     label: '签名（Sign）',  placeholder: '灵图', required: true,
    hint: '阿里云控制台「国内消息 → 签名管理」审核通过的签名名称，跟那边一字不差。' },
  { key: 'sms_template_code', label: '模板编号',      placeholder: 'SMS_xxxxxxxxx', required: true,
    hint: '「国内消息 → 模板管理」拿到的 TemplateCode，模板内容须含 ${code} 占位。' },
  { key: 'sms_endpoint',      label: 'Endpoint（可选）', placeholder: 'dysmsapi.aliyuncs.com',
    hint: '默认走全局 dysmsapi.aliyuncs.com。如果你的网络对该域名有 DNS 劫持，可改成 dysmsapi.cn-hangzhou.aliyuncs.com。' },
  { key: 'sms_region',        label: 'Region（可选）',  placeholder: '默认 cn-hangzhou（仅 endpoint 留空时生效）',
    hint: '只在 Endpoint 留空时生效。endpoint 优先级 > region。' },
]

export function SmsConnectTab() {
  const user = useCurrentUser()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [secretRevealed, setSecretRevealed] = useState(false)
  const [testPhone, setTestPhone] = useState('')

  // 只有 platform owner 才能看
  const canView = !!user?.is_platform_owner

  const { data: status } = useQuery({
    queryKey: ['sms-status'],
    queryFn: api.sms.status,
    enabled: canView,
    refetchInterval: false,
  })

  const { data: config } = useQuery<Record<string, any>>({
    queryKey: ['config'],
    queryFn: () => api.config.get() as any,
    enabled: canView,
  })

  // 把 config 里的 sms_* 灌进表单
  useEffect(() => {
    if (!config) return
    const next: Record<string, string> = {}
    for (const f of FIELDS) {
      next[f.key] = String(config[f.key] || '')
    }
    setForm(next)
  }, [config])

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, any>) => api.config.update(payload),
    onSuccess: () => {
      toast.success('短信凭据已保存')
      queryClient.invalidateQueries({ queryKey: ['config'] })
      queryClient.invalidateQueries({ queryKey: ['sms-status'] })
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`保存失败：${msg}`)
    },
  })

  const handleSave = () => {
    const payload: Record<string, any> = { sms_provider: 'aliyun' }
    for (const f of FIELDS) {
      const v = (form[f.key] ?? '').trim()
      // mask 形态（含 ****）跳过：保留服务端原值
      if (f.secret && v.includes('****')) continue
      payload[f.key] = v || null
    }
    saveMutation.mutate(payload)
  }

  const testMutation = useMutation({
    mutationFn: () => api.sms.test(testPhone),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message || '测试短信已发送')
      else toast.error(`测试失败：${r.error || '未知错误'}`)
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`测试失败：${msg}`)
    },
  })

  const phoneValid = /^1[3-9]\d{9}$/.test(testPhone)

  if (!canView) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={ShieldCheck}
          title="仅平台超级管理员可访问"
          description="短信凭据是平台级资源，普通组织 owner 看不到"
        />
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-5">
      {/* 状态卡 */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-4">
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare size={14} className="text-foreground/55" />
          <h2 className="text-[13px] font-semibold text-foreground/80">阿里云短信服务</h2>
          <InfoHint text={
            '客户版打包已烤入龙蟾科技的 SMS 凭据，开箱即用。\n' +
            '只有需要覆盖（例如换签名 / 换 RAM 子账号）时才在下方填写。\n' +
            '填写的凭据存本地 config.json，优先级低于环境变量。'
          } />
          {status?.configured ? (
            <span className="text-[10px] text-success inline-flex items-center gap-1 ml-auto">
              <CheckCircle2 size={11} /> 已配置
            </span>
          ) : (
            <span className="text-[10px] text-amber-600 inline-flex items-center gap-1 ml-auto">
              <XCircle size={11} /> 未配置
            </span>
          )}
        </div>

        {/* 凭据来源指示 */}
        {status?.source === 'env' && (
          <div className="mb-2 text-[11px] text-foreground/65 inline-flex items-start gap-1.5 rounded-md bg-accent/[0.06] px-2 py-1.5">
            <CheckCircle2 size={12} className="text-accent shrink-0 mt-0.5" />
            <span>已由发布方预配置（开箱即用，无需填写）。如需覆盖请在下方填表保存。</span>
          </div>
        )}
        {status?.source === 'mixed' && (
          <div className="mb-2 text-[11px] text-amber-700 dark:text-amber-400 inline-flex items-start gap-1.5 rounded-md bg-amber-500/[0.08] px-2 py-1.5">
            <InfoHint text="环境变量优先级 > config.json，所以你下方填的可能没生效。要让填表生效，需先 unset 环境变量。" size={11} />
            <span>检测到环境变量同时有效，可能覆盖了你的配置。</span>
          </div>
        )}

        {status?.configured && (
          <div className="text-[11px] text-foreground/55 space-y-0.5 tabular-nums">
            <div>签名：<span className="font-mono text-foreground/85">{status.sign_name}</span></div>
            <div>模板：<span className="font-mono text-foreground/85">{status.template_code}</span></div>
            <div>Endpoint：<span className="font-mono text-foreground/85">{status.endpoint_resolved}</span></div>
            <div>AccessKey：<span className="font-mono text-foreground/85">{status.access_key_masked || '—'}</span></div>
          </div>
        )}
      </div>

      {/* 凭据表单 */}
      <div className="space-y-3">
        {FIELDS.map((f) => {
          const isSecret = !!f.secret
          const isPassword = isSecret && !secretRevealed
          return (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={f.key} className="text-[12px] inline-flex items-center gap-1">
                {f.label}
                {f.required && <span className="text-destructive">*</span>}
                {f.hint && <InfoHint text={f.hint} />}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={f.key}
                  type={isPassword ? 'password' : 'text'}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  className="text-[12.5px]"
                />
                {isSecret && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSecretRevealed((v) => !v)}
                    title={secretRevealed ? '隐藏' : '显示'}
                  >
                    {secretRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 size={12} className="animate-spin mr-1.5" />}
          保存
        </Button>
      </div>

      {/* 测试发短信 */}
      {status?.configured && (
        <div className="rounded-lg border border-foreground/8 p-4 space-y-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[12.5px] font-medium text-foreground/80">发测试短信</h3>
            <InfoHint text="给一个真实手机号发一条测试短信，验证凭据真的对。测试码固定 999999。" />
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center px-3 h-9 rounded-md border border-foreground/15 bg-foreground/[0.02] text-[12px] text-foreground/55 shrink-0">
              +86
            </span>
            <Input
              type="tel"
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              placeholder="138 1234 5678"
              className="flex-1 h-9 text-[12.5px] tabular-nums"
            />
            <Button
              onClick={() => testMutation.mutate()}
              disabled={!phoneValid || testMutation.isPending}
            >
              {testMutation.isPending
                ? <Loader2 size={12} className="animate-spin mr-1.5" />
                : <Send size={12} className="mr-1.5" />}
              发测试
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
