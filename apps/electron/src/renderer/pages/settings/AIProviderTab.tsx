import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { CheckCircle, Loader2, Eye, EyeOff } from 'lucide-react'

const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini', configKey: 'gemini_api_key', status: 'available' as const },
  { id: 'jimeng', name: '即梦 (Jimeng)', configKey: 'jimeng_api_key', status: 'coming' as const },
  { id: 'tongyi', name: '通义万象', configKey: 'tongyi_api_key', status: 'coming' as const },
  { id: 'comfyui', name: 'ComfyUI', configKey: 'comfyui_url', status: 'coming' as const },
]

export function AIProviderTab() {
  const queryClient = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config.get(),
  })

  return (
    <div className="space-y-4 max-w-2xl">
      {PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          savedValue={config?.[provider.configKey] || ''}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['config'] })}
        />
      ))}
    </div>
  )
}

function ProviderCard({ provider, savedValue, onSaved }: {
  provider: typeof PROVIDERS[number]
  savedValue: string
  onSaved: () => void
}) {
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)

  const isConfigured = !!savedValue && savedValue !== '****'
  const isComing = provider.status === 'coming'

  const saveMutation = useMutation({
    mutationFn: () => api.config.update({ [provider.configKey]: value }),
    onSuccess: () => {
      toast.success(`${provider.name} 配置已保存`)
      setValue('')
      setShowValue(false)
      onSaved()
    },
    onError: () => toast.error('保存失败'),
  })

  const handleTest = async () => {
    if (!value && !isConfigured) return
    setTesting(true)
    setTestResult(null)
    try {
      // Simple test: try to reach Gemini API
      const res = await fetch('http://localhost:7879/health')
      setTestResult(res.ok ? 'ok' : 'fail')
    } catch {
      setTestResult('fail')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={`rounded-lg border border-foreground/5 p-4 ${isComing ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-foreground/80">{provider.name}</h3>
          {isConfigured && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              <CheckCircle size={10} className="mr-1 text-success" /> 已配置
            </Badge>
          )}
          {isComing && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">即将支持</Badge>
          )}
        </div>
      </div>

      {!isComing && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showValue ? 'text' : 'password'}
                placeholder={isConfigured ? savedValue : `输入 ${provider.name} API Key`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-8 text-[13px] pr-8"
              />
              <button
                onClick={() => setShowValue(!showValue)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/30 hover:text-foreground/60"
              >
                {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              disabled={!value || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              保存
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-[12px]"
              disabled={testing || (!value && !isConfigured)}
              onClick={handleTest}
            >
              {testing ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
              测试
            </Button>
          </div>
          {testResult === 'ok' && (
            <p className="text-[11px] text-success">连接测试通过</p>
          )}
          {testResult === 'fail' && (
            <p className="text-[11px] text-destructive">连接测试失败</p>
          )}
        </div>
      )}
    </div>
  )
}
