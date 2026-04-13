import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  CheckCircle, Loader2, Eye, EyeOff, Plus, Trash2, ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ── Provider definitions ──

interface ProviderDef {
  id: string
  name: string
  description: string
  fields: FieldDef[]
  capabilities: string[]
}

interface FieldDef {
  key: string
  label: string
  type: 'password' | 'text' | 'url'
  placeholder: string
}

const VISION_PROVIDERS: ProviderDef[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: '图像理解 + 多模态标注，推荐用于 AI 打标',
    capabilities: ['打标', '描述'],
    fields: [
      { key: 'gemini_api_key', label: 'API Key', type: 'password', placeholder: 'AIza...' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o 视觉理解 + DALL-E 图像生成',
    capabilities: ['打标', '描述', '生成'],
    fields: [
      { key: 'openai_api_key', label: 'API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
  {
    id: 'qwen_vl',
    name: '通义千问 VL',
    description: '阿里云视觉语言模型，国内直连速度快',
    capabilities: ['打标', '描述'],
    fields: [
      { key: 'qwen_api_key', label: 'API Key', type: 'password', placeholder: 'sk-...' },
    ],
  },
]

const GENERATION_PROVIDERS: ProviderDef[] = [
  {
    id: 'jimeng',
    name: '即梦 (Jimeng)',
    description: '字节跳动图像生成，适合营销素材和海报',
    capabilities: ['生成', '编辑'],
    fields: [
      { key: 'jimeng_api_key', label: 'API Key', type: 'password', placeholder: '' },
    ],
  },
  {
    id: 'tongyi_wanxiang',
    name: '通义万象',
    description: '阿里云图像生成，支持风格变换和扩展',
    capabilities: ['生成', '风格'],
    fields: [
      { key: 'tongyi_wanxiang_api_key', label: 'API Key', type: 'password', placeholder: '' },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 CogView',
    description: '智谱 AI 图像生成',
    capabilities: ['生成'],
    fields: [
      { key: 'zhipu_api_key', label: 'API Key', type: 'password', placeholder: '' },
    ],
  },
  {
    id: 'comfyui',
    name: 'ComfyUI (本地)',
    description: '本地部署的 ComfyUI，适合复杂工作流',
    capabilities: ['生成', '编辑', '超分', '风格'],
    fields: [
      { key: 'comfyui_url', label: '服务地址', type: 'url', placeholder: 'http://127.0.0.1:8188' },
    ],
  },
]

// ── Component ──

export function AIProviderTab() {
  const queryClient = useQueryClient()
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config.get(),
  })

  // Custom relay stations from config
  const relays: CustomRelay[] = config?.custom_relays
    ? JSON.parse(config.custom_relays === '****' ? '[]' : config.custom_relays)
    : []

  const onSaved = () => queryClient.invalidateQueries({ queryKey: ['config'] })

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Vision / Tagging Providers */}
      <section>
        <h2 className="text-[13px] font-semibold text-foreground/70 mb-3">图像理解 · 用于打标和描述</h2>
        <div className="space-y-3">
          {VISION_PROVIDERS.map((p) => (
            <ProviderCard key={p.id} provider={p} config={config || {}} onSaved={onSaved} />
          ))}
        </div>
      </section>

      <Separator />

      {/* Generation Providers */}
      <section>
        <h2 className="text-[13px] font-semibold text-foreground/70 mb-3">图像生成 · 用于 AI 工坊策略</h2>
        <div className="space-y-3">
          {GENERATION_PROVIDERS.map((p) => (
            <ProviderCard key={p.id} provider={p} config={config || {}} onSaved={onSaved} />
          ))}
        </div>
      </section>

      <Separator />

      {/* Custom Relay Stations */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-semibold text-foreground/70">自定义中转站 · OpenAI 兼容接口</h2>
        </div>
        <p className="text-[11px] text-foreground/40 mb-3">
          支持任何兼容 OpenAI API 格式的中转服务（如硅基流动、OpenRouter、one-api 等），可用于打标和生成
        </p>
        <div className="space-y-3">
          {relays.map((relay, idx) => (
            <RelayCard
              key={idx}
              relay={relay}
              index={idx}
              allRelays={relays}
              onSaved={onSaved}
            />
          ))}
          <AddRelayButton relays={relays} onSaved={onSaved} />
        </div>
      </section>
    </div>
  )
}

// ── Provider Card ──

function ProviderCard({ provider, config, onSaved }: {
  provider: ProviderDef
  config: Record<string, string>
  onSaved: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)

  const isConfigured = provider.fields.some((f) => {
    const v = config[f.key]
    return v && v !== '****' && v.length > 4
  })

  const saveMutation = useMutation({
    mutationFn: () => {
      const data: Record<string, string> = {}
      provider.fields.forEach((f) => {
        if (values[f.key]) data[f.key] = values[f.key]
      })
      return api.config.update(data)
    },
    onSuccess: () => {
      toast.success(`${provider.name} 配置已保存`)
      setValues({})
      onSaved()
    },
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const testKey = values[provider.fields[0]?.key] || undefined
      const testUrl = provider.id === 'comfyui'
        ? (values.comfyui_url || config.comfyui_url || undefined)
        : undefined
      const res = await fetch('http://localhost:7879/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: provider.id,
          api_key: testKey,
          base_url: testUrl,
        }),
      })
      setTestResult(await res.json())
    } catch {
      setTestResult({ ok: false, error: '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const hasInput = provider.fields.some((f) => values[f.key])

  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-foreground/80">{provider.name}</h3>
          {isConfigured && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              <CheckCircle size={10} className="mr-1 text-success" /> 已配置
            </Badge>
          )}
        </div>
        <div className="flex gap-1">
          {provider.capabilities.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/40">
              {c}
            </Badge>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-foreground/40 mb-3">{provider.description}</p>

      <div className="space-y-2">
        {provider.fields.map((field) => (
          <div key={field.key} className="flex gap-2">
            <label className="text-[12px] text-foreground/50 w-20 pt-1.5 shrink-0">{field.label}</label>
            <div className="relative flex-1">
              <Input
                type={field.type === 'password' && !showKeys[field.key] ? 'password' : 'text'}
                placeholder={isConfigured ? (config[field.key] || '已配置') : field.placeholder}
                value={values[field.key] || ''}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                className="h-8 text-[13px] pr-8"
              />
              {field.type === 'password' && (
                <button
                  onClick={() => setShowKeys({ ...showKeys, [field.key]: !showKeys[field.key] })}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/30 hover:text-foreground/60"
                >
                  {showKeys[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
            </div>
          </div>
        ))}

        <div className="flex gap-2 justify-end pt-1">
          <Button
            variant="ghost" size="sm" className="h-7 text-[12px]"
            disabled={testing || (!hasInput && !isConfigured)}
            onClick={handleTest}
          >
            {testing && <Loader2 size={12} className="animate-spin mr-1" />}
            测试连接
          </Button>
          <Button
            variant="outline" size="sm" className="h-7 text-[12px]"
            disabled={!hasInput || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            保存
          </Button>
        </div>

        {testResult && (
          <p className={cn('text-[11px]', testResult.ok ? 'text-success' : 'text-destructive')}>
            {testResult.ok ? testResult.message : testResult.error}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Custom Relay ──

interface CustomRelay {
  name: string
  base_url: string
  api_key: string
  model: string
  capabilities: string[]
}

function RelayCard({ relay, index, allRelays, onSaved }: {
  relay: CustomRelay
  index: number
  allRelays: CustomRelay[]
  onSaved: () => void
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)

  const deleteMutation = useMutation({
    mutationFn: () => {
      const updated = allRelays.filter((_, i) => i !== index)
      return api.config.update({ custom_relays: JSON.stringify(updated) })
    },
    onSuccess: () => {
      toast.success('已删除')
      onSaved()
    },
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch('http://localhost:7879/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: 'openai_compatible',
          base_url: relay.base_url,
          api_key: relay.api_key,
          model: relay.model,
        }),
      })
      setTestResult(await res.json())
    } catch {
      setTestResult({ ok: false, error: '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-foreground/80">{relay.name}</h3>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            <CheckCircle size={10} className="mr-1 text-success" /> 已配置
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {relay.capabilities.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/40">{c}</Badge>
          ))}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-foreground/30 hover:text-destructive" onClick={() => deleteMutation.mutate()}>
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
      <div className="text-[11px] text-foreground/40 space-y-0.5">
        <p>地址: {relay.base_url}</p>
        <p>模型: {relay.model || '默认'}</p>
      </div>
      <div className="flex gap-2 justify-end mt-2">
        <Button variant="ghost" size="sm" className="h-7 text-[12px]" disabled={testing} onClick={handleTest}>
          {testing && <Loader2 size={12} className="animate-spin mr-1" />}
          测试连接
        </Button>
      </div>
      {testResult && (
        <p className={cn('text-[11px] mt-1', testResult.ok ? 'text-success' : 'text-destructive')}>
          {testResult.ok ? testResult.message : testResult.error}
        </p>
      )}
    </div>
  )
}

function AddRelayButton({ relays, onSaved }: { relays: CustomRelay[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!name || !baseUrl || !apiKey) throw new Error('请填写必填项')
      const newRelay: CustomRelay = {
        name,
        base_url: baseUrl,
        api_key: apiKey,
        model,
        capabilities: ['打标', '生成'],
      }
      const updated = [...relays, newRelay]
      return api.config.update({ custom_relays: JSON.stringify(updated) })
    },
    onSuccess: () => {
      toast.success('中转站已添加')
      setOpen(false)
      setName('')
      setBaseUrl('')
      setApiKey('')
      setModel('')
      onSaved()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-foreground/10 p-3 text-[12px] text-foreground/40 hover:border-foreground/20 hover:text-foreground/60 transition-colors flex items-center justify-center gap-1.5"
      >
        <Plus size={14} /> 添加中转站
      </button>
    )
  }

  return (
    <div className="rounded-lg border border-accent/20 bg-accent/[0.03] p-4 space-y-3">
      <h3 className="text-[13px] font-medium text-foreground/80">添加自定义中转站</h3>
      <div className="space-y-2">
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/50 w-20 shrink-0">名称 *</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：硅基流动" className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/50 w-20 shrink-0">Base URL *</label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.siliconflow.cn/v1" className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/50 w-20 shrink-0">API Key *</label>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/50 w-20 shrink-0">默认模型</label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="可选，例如 gpt-4o / Qwen/Qwen2.5-VL-72B" className="h-8 text-[13px]" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => setOpen(false)}>取消</Button>
        <Button size="sm" className="h-7 text-[12px]" disabled={!name || !baseUrl || !apiKey || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          添加
        </Button>
      </div>
    </div>
  )
}
