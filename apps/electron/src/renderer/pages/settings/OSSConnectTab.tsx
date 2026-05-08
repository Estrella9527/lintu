import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Eye, EyeOff, Loader2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { InfoHint } from '@/components/shared/InfoHint'
import { cn } from '@/lib/utils'

type TestResult =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success'; mode: string; message: string }
  | { kind: 'failure'; code: string; message: string }

const FIELDS = [
  { key: 'oss_provider',          label: 'Provider',     placeholder: 'aliyun',                                hint: '当前仅支持 aliyun（阿里云 OSS）' },
  { key: 'oss_endpoint',          label: 'Endpoint',     placeholder: 'oss-cn-hangzhou.aliyuncs.com',          hint: '不带 https:// 前缀' },
  { key: 'oss_bucket',            label: 'Bucket',       placeholder: 'lintu-cdn-prod',                        hint: '阿里云 OSS bucket 名称' },
  { key: 'oss_access_key',        label: 'Access Key',   placeholder: 'LTAIxxxxxxxxxxxxxxxx',                  hint: '阿里云子账号 access_key_id' },
  { key: 'oss_access_secret',     label: 'Access Secret',placeholder: '************',                          hint: '会自动掩码显示；保存后字段为 ****', secret: true },
  { key: 'oss_cdn_base',          label: 'CDN Base URL', placeholder: 'https://cdn.example.com',               hint: '可选；填了走 CDN，否则走 OSS bucket 直链' },
  { key: 'oss_signed_url_ttl_sec',label: '签名 URL TTL', placeholder: '0',                                     hint: '0 = 不签名（公开 bucket）；>0 = 签名 URL 的有效秒数', numeric: true },
] as const

export function OSSConnectTab() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [secretRevealed, setSecretRevealed] = useState(false)
  const [test, setTest] = useState<TestResult>({ kind: 'idle' })

  const { data: config, isLoading } = useQuery<Record<string, string>>({
    queryKey: ['config'],
    queryFn: () => api.config.get(),
  })

  useEffect(() => {
    if (!config) return
    const initial: Record<string, string> = {}
    for (const f of FIELDS) initial[f.key] = String(config[f.key] ?? '')
    if (!initial.oss_provider) initial.oss_provider = 'aliyun'
    setForm(initial)
  }, [config])

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, string>) => api.config.update(payload),
    onSuccess: () => {
      toast.success('OSS 配置已保存')
      queryClient.invalidateQueries({ queryKey: ['config'] })
    },
    onError: (e: any) => toast.error(`保存失败：${e?.message || e}`),
  })

  const handleTest = async () => {
    setTest({ kind: 'testing' })
    try {
      const result = await api.config.testOss({
        oss_provider:      form.oss_provider || 'aliyun',
        oss_endpoint:      form.oss_endpoint || '',
        oss_bucket:        form.oss_bucket || '',
        oss_access_key:    form.oss_access_key || undefined,
        oss_access_secret: form.oss_access_secret || undefined,
        oss_cdn_base:      form.oss_cdn_base || undefined,
      })
      if (result.ok) {
        setTest({ kind: 'success', mode: result.mode || 'read_write', message: result.message || '连接成功' })
      } else {
        setTest({ kind: 'failure', code: result.code || 'unknown', message: result.message || '未知错误' })
      }
    } catch (e: any) {
      setTest({ kind: 'failure', code: 'request_error', message: e?.message || '请求失败' })
    }
  }

  const handleSave = () => {
    // 不发空值（避免清掉别人的设置）；secret 字段如果是 **** 占位也不发
    const payload: Record<string, string> = {}
    for (const f of FIELDS) {
      const v = (form[f.key] ?? '').trim()
      if (!v) continue
      if ((f as any).secret && v.includes('****') && !secretRevealed) continue
      payload[f.key] = v
    }
    saveMutation.mutate(payload)
  }

  if (isLoading) {
    return <div className="text-[12px] text-foreground/45">加载中…</div>
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[14px] font-semibold text-foreground/85">OSS / CDN 分发目标</h3>
        <InfoHint text={
          '原图与缩略图会上传到这个 bucket，UGC 端通过 CDN 拉取。\n' +
          '凭据保存在本地 config.json，永远不入 git。'
        } />
      </div>

      <div className="space-y-3">
        {FIELDS.map((f) => {
          const isSecret = (f as any).secret
          const isPassword = isSecret && !secretRevealed
          return (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={f.key} className="text-[12px] text-foreground/75 inline-flex items-center gap-1">
                {f.label}
                {f.hint && <InfoHint text={f.hint} />}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={f.key}
                  type={isPassword ? 'password' : (f as any).numeric ? 'number' : 'text'}
                  value={form[f.key] ?? ''}
                  placeholder={f.placeholder}
                  onChange={(e) => {
                    setForm({ ...form, [f.key]: e.target.value })
                    setTest({ kind: 'idle' })
                  }}
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

      <div className="flex items-center gap-3 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={test.kind === 'testing'}
        >
          {test.kind === 'testing' ? (
            <Loader2 size={12} className="animate-spin mr-1.5" />
          ) : null}
          测试连接
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1.5" /> : null}
          保存
        </Button>
        {test.kind === 'success' && (
          <span className="flex items-center gap-1 text-[12px] text-emerald-600/85">
            <CheckCircle2 size={12} />
            {test.message}
            <span className="text-foreground/45 ml-1">({test.mode})</span>
          </span>
        )}
        {test.kind === 'failure' && (
          <span className={cn('flex items-center gap-1 text-[12px] text-destructive')}>
            <XCircle size={12} />
            <span title={test.message}>{test.code}：{test.message.slice(0, 80)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
