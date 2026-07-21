import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, apiFetchRaw } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  CheckCircle, Loader2, Eye, EyeOff, Pencil, Plus, Trash2, ExternalLink, ShieldCheck, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ExportImportButtons } from '@/components/settings/ExportImportButtons'
import { InfoHint } from '@/components/shared/InfoHint'

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
    <div className="space-y-8 max-w-3xl">
      <div className="flex justify-end -mb-4">
        <ExportImportButtons
          domainLabel="AI 服务商"
          exportPath="/config/export-providers"
          importPath="/config/import-providers"
          exportFilename="lintu-providers.json"
          exportSecretsToggle={true}
          importBodyAdapter={(parsed) => ({
            config: parsed?.config || parsed,
            mode: 'merge',
          })}
          onImportDone={onSaved}
        />
      </div>
      {/* 必须等 config 真正加载完再挂载这两张卡：它们用 useState 在挂载时一次性
          读取 config，若此时 config 还是 undefined({})，state 会被锁成空字符串且
          再不同步——保存时就把 default_image_provider 等清空，导致 provider chain
          为空、"生成不了"。延迟挂载保证 useState 初始值=真实配置。 */}
      {config ? <RoleAssignmentSection config={config} onSaved={onSaved} /> : null}

      {config ? <TaggerAuditCard config={config} onSaved={onSaved} /> : null}

      <ArkProviderCard relays={relays} onSaved={onSaved} />

      <SectionShell
        title="图像理解"
        subtitle="用于 AI 打标、图片描述、方向矫正等高频视觉调用"
      >
        <div className="space-y-3">
          {VISION_PROVIDERS.map((p) => (
            <ProviderCard key={p.id} provider={p} config={config || {}} onSaved={onSaved} />
          ))}
        </div>
      </SectionShell>

      <SectionShell
        title="图像生成"
        subtitle="用于 AI 工坊单图与批量生产"
      >
        <div className="space-y-3">
          {GENERATION_PROVIDERS.map((p) => (
            <ProviderCard key={p.id} provider={p} config={config || {}} onSaved={onSaved} />
          ))}
        </div>
      </SectionShell>

      <SectionShell
        title="自定义中转站"
        subtitle="兼容 OpenAI 接口的第三方中转（硅基流动、OpenRouter、one-api 等），可用于打标和生成"
      >
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
      </SectionShell>
    </div>
  )
}

/** Standard section wrapper: title + subtitle on top, content below. Used to
 * keep all settings sections visually consistent without re-wrapping every
 * inner card in another border. */
function SectionShell({
  title, subtitle, action, children,
}: {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-3">
        <h2 className="text-[13px] font-semibold text-foreground/70">{title}</h2>
        {subtitle && <InfoHint text={subtitle} />}
        {action && <div className="ml-auto shrink-0">{action}</div>}
      </div>
      {children}
    </section>
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
      const res = await apiFetchRaw('/providers/test', {
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
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-foreground/80">{provider.name}</h3>
          {provider.description && <InfoHint text={provider.description} />}
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

const ALL_CAPABILITIES = ['打标', '描述', '生成', '编辑', '向量化'] as const

function RelayCard({ relay, index, allRelays, onSaved }: {
  relay: CustomRelay
  index: number
  allRelays: CustomRelay[]
  onSaved: () => void
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)
  const [editing, setEditing] = useState(false)

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
      const res = await apiFetchRaw('/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: 'openai_compatible',
          provider_name: relay.name,
        }),
      })
      setTestResult(await res.json())
    } catch {
      setTestResult({ ok: false, error: '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  if (editing) {
    return (
      <RelayEditForm
        original={relay}
        index={index}
        allRelays={allRelays}
        onCancel={() => setEditing(false)}
        onSaved={() => { setEditing(false); onSaved() }}
      />
    )
  }

  return (
    <div className="rounded-lg border border-foreground/5 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-[13px] font-medium text-foreground/80 truncate">{relay.name}</h3>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
            <CheckCircle size={10} className="mr-1 text-success" /> 已配置
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {relay.capabilities.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px] px-1.5 py-0 text-foreground/40">{c}</Badge>
          ))}
          <Button
            variant="ghost" size="sm"
            className="h-6 w-6 p-0 text-foreground/40 hover:text-foreground/80"
            title="编辑"
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} />
          </Button>
          <Button
            variant="ghost" size="sm"
            className="h-6 w-6 p-0 text-foreground/30 hover:text-destructive"
            title="删除"
            onClick={() => { if (confirm(`确认删除中转站「${relay.name}」？`)) deleteMutation.mutate() }}
          >
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

function RelayEditForm({
  original, index, allRelays, onCancel, onSaved,
}: {
  original: CustomRelay
  index: number
  allRelays: CustomRelay[]
  onCancel: () => void
  onSaved: () => void
}) {
  // The api_key field comes back from the backend already masked (e.g. "sk-A****").
  // We keep that masked string as the initial value; if the user doesn't touch
  // it, we send it back unchanged and the backend's mask-detection logic
  // restores the real key from disk. The user only types here to actually
  // rotate the key.
  const [name, setName] = useState(original.name)
  const [baseUrl, setBaseUrl] = useState(original.base_url)
  const [apiKey, setApiKey] = useState(original.api_key)
  const [model, setModel] = useState(original.model || '')
  const [showKey, setShowKey] = useState(false)
  const [caps, setCaps] = useState<string[]>(original.capabilities || [])

  const looksMasked = (v: string) => v.includes('****')

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!name.trim() || !baseUrl.trim() || !apiKey.trim()) {
        throw new Error('请填写名称、地址和 API Key')
      }
      const updated = allRelays.map((r, i): CustomRelay => i === index ? {
        name: name.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey,                    // masked → backend keeps original
        model: model.trim(),
        capabilities: caps.length ? caps : ['打标', '生成'],
      } : r)
      return api.config.update({ custom_relays: JSON.stringify(updated) })
    },
    onSuccess: () => {
      toast.success('中转站已更新')
      onSaved()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const toggleCap = (c: string) => {
    setCaps((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c])
  }

  return (
    <div className="rounded-lg border border-accent/20 bg-accent/[0.03] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Pencil size={12} className="text-foreground/55" />
        <h3 className="text-[13px] font-medium text-foreground/85">编辑中转站</h3>
      </div>
      <div className="space-y-2">
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0">名称 *</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0">Base URL *</label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-start">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0 pt-1.5">API Key *</label>
          <div className="relative flex-1">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="留空保持原值；填写则覆盖"
              className="h-8 text-[13px] pr-8"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/30 hover:text-foreground/60"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            {looksMasked(apiKey) && (
              <p className="text-[10px] text-foreground/40 mt-1">当前为掩码值；保存时不修改实际 Key。</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0">默认模型</label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="可选" className="h-8 text-[13px]" />
        </div>
        <div className="flex gap-2 items-start">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0 pt-1">能力</label>
          <div className="flex flex-wrap gap-1.5">
            {ALL_CAPABILITIES.map((c) => {
              const active = caps.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleCap(c)}
                  className={cn(
                    'px-2 h-6 rounded text-[11px] border transition-colors',
                    active
                      ? 'border-accent/40 bg-accent/15 text-accent'
                      : 'border-foreground/10 text-foreground/55 hover:bg-foreground/[0.04]',
                  )}
                >
                  {c}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={onCancel}>取消</Button>
        <Button
          size="sm" className="h-7 text-[12px]"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}

// ── Role Assignment ────────────────────────────────────────────────────────

interface AvailableProvider {
  id: string         // "gemini" or "relay:<name>"
  name: string
  model?: string
  kind: 'builtin' | 'relay'
}

function RoleAssignmentSection({ config, onSaved }: {
  config: Record<string, string>
  onSaved: () => void
}) {
  const [general, setGeneral] = useState<string>(config.default_general_provider || '')
  const [image, setImage] = useState<string>(config.default_image_provider || '')
  const [parser, setParser] = useState<string>(config.default_parser_provider || '')
  const [generalModel, setGeneralModel] = useState<string>(config.general_provider_model || '')
  const [parserModel, setParserModel] = useState<string>(config.parser_provider_model || '')
  const [outputSize, setOutputSize] = useState<string>(config.image_output_size || '')

  const { data: providers } = useQuery<AvailableProvider[]>({
    queryKey: ['available-providers'],
    queryFn: () => apiFetchRaw('/providers/available').then((r) => r.json()),
    refetchInterval: 5000,
  })

  const save = useMutation({
    mutationFn: () => api.config.update({
      default_general_provider: general,
      default_image_provider: image,
      default_parser_provider: parser,
      general_provider_model: generalModel,
      parser_provider_model: parserModel,
      image_output_size: outputSize,
    }),
    onSuccess: () => { toast.success('模型分配已保存'); onSaved() },
    onError: (e: Error) => toast.error(e.message),
  })

  const dirty =
    general !== (config.default_general_provider || '') ||
    image !== (config.default_image_provider || '') ||
    parser !== (config.default_parser_provider || '') ||
    generalModel !== (config.general_provider_model || '') ||
    parserModel !== (config.parser_provider_model || '') ||
    outputSize !== (config.image_output_size || '')

  const renderOptions = (list: AvailableProvider[] | undefined, autoLabel = '— 自动选择（第一家可用）—') => (
    <>
      <option value="">{autoLabel}</option>
      {list?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}{p.model ? ` · ${p.model}` : ''}
        </option>
      ))}
    </>
  )

  return (
    <section>
      <div className="flex items-center gap-1.5 mb-3">
        <h2 className="text-[13px] font-semibold text-foreground/70">模型分配</h2>
        <InfoHint text="按角色拆分：视觉 / 打标（高频低成本）、提示词解析（罕见高质量）、图像生成。" />
      </div>
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-4 space-y-3">
        <div className="space-y-1">
          <label className="text-[12px] text-foreground/60 inline-flex items-center gap-1">
            视觉 / 打标 (general)
            <InfoHint text="用于 AI 打标、图片方向矫正。推荐 Doubao Seed 2.0 Lite / Pro（中文 + 性价比）。" />
          </label>
          <select
            value={general}
            onChange={(e) => setGeneral(e.target.value)}
            className="w-full h-9 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
          >
            {renderOptions(providers)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[12px] text-foreground/60 inline-flex items-center gap-1">
            提示词文档解析 (parser)
            <InfoHint text="用于 md / docx / xlsx / PDF 提示词文档结构化抽取。推荐 GPT-5 / Claude Opus 4.6（长上下文 + 强 JSON）。" />
          </label>
          <select
            value={parser}
            onChange={(e) => setParser(e.target.value)}
            className="w-full h-9 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
          >
            {renderOptions(providers, '— 跟随通用模型 —')}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-[12px] text-foreground/60 inline-flex items-center gap-1">
            图像生成 (image)
            <InfoHint text="用于 AI 工坊单图 / 批量生产。推荐 GPT-Image-2（细节最好）；备选 Seedream 4.0（中文 prompt）。" />
          </label>
          <select
            value={image}
            onChange={(e) => setImage(e.target.value)}
            className="w-full h-9 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
          >
            {renderOptions(providers)}
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[12px] text-foreground/60 inline-flex items-center gap-1">
            输出分辨率
            <InfoHint text="更高分辨率细节更好但速度更慢、成本更高。Seedream 自动映射 K 简写，gpt-image 使用 WxH。" />
          </label>
          <select
            value={outputSize}
            onChange={(e) => setOutputSize(e.target.value)}
            className="w-full h-9 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
          >
            <option value="">自动 · 模型默认（gpt-image: 2048²，Seedream: 4K）</option>
            <option value="1024x1024">1K · 1024 × 1024（最快、最便宜）</option>
            <option value="1536x1536">1.5K · 1536 × 1536</option>
            <option value="2048x2048">2K · 2048 × 2048（推荐）</option>
            <option value="3072x2048">3K 横幅 · 3072 × 2048</option>
            <option value="2048x3072">3K 竖幅 · 2048 × 3072</option>
            <option value="4096x4096">4K · 4096 × 4096（仅 Seedream，较慢）</option>
          </select>
        </div>
        <details className="text-[11px] text-foreground/40">
          <summary className="cursor-pointer hover:text-foreground/60">高级：模型名称覆盖</summary>
          <div className="mt-2 space-y-2">
            <div className="space-y-1">
              <label className="text-[11px] text-foreground/50">视觉 / 打标 模型覆盖</label>
              <Input
                value={generalModel}
                onChange={(e) => setGeneralModel(e.target.value)}
                placeholder="留空使用 provider 默认"
                className="h-7 text-[12px] font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-foreground/50">解析模型覆盖</label>
              <Input
                value={parserModel}
                onChange={(e) => setParserModel(e.target.value)}
                placeholder="例如 gpt-5 / claude-opus-4-6"
                className="h-7 text-[12px] font-mono"
              />
            </div>
          </div>
        </details>
        <div className="flex justify-end">
          <Button
            size="sm" className="h-7 text-[12px]"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            保存分配
          </Button>
        </div>
        {(!providers || providers.length === 0) && (
          <p className="text-[11px] text-warning">
            还没有可用的 provider。请先在下方配置 Gemini 或添加自定义中转站。
          </p>
        )}
      </div>
    </section>
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

// ── Volcengine Ark dedicated card ───────────────────────────────────────────
//
// One API key + one model per role, saved as 3 named relays (`ark-chat`,
// `ark-embedding`, `ark-image`). Automatically wires the role-assignment
// config so the user doesn't have to manually pick from dropdowns.

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const ARK_RELAY_NAMES = {
  chat: 'ark-chat',
  embedding: 'ark-embedding',
  image: 'ark-image',
} as const

const ARK_MODEL_OPTIONS = {
  chat: [
    { value: 'doubao-seed-2-0-pro-260215', label: 'Doubao Seed 2.0 Pro (高准确度, 通用+视觉)' },
    { value: 'doubao-seed-2-0-lite-260215', label: 'Doubao Seed 2.0 Lite (推荐, 高性价比)' },
    { value: 'doubao-seed-1-6-vision-250615', label: 'Doubao Seed 1.6 Vision' },
    { value: 'doubao-1-5-pro-32k-character-241215', label: 'Doubao 1.5 Pro 32K' },
  ],
  embedding: [
    { value: 'doubao-embedding-vision-250615', label: 'Doubao Embedding Vision 250615 (默认 2048d)' },
    { value: 'doubao-embedding-vision-251215', label: 'Doubao Embedding Vision 251215 (更新)' },
  ],
  image: [
    { value: 'doubao-seedream-4-0-250828', label: 'Doubao Seedream 4.0 (推荐, 多图融合)' },
    { value: 'doubao-seedream-5-0-lite', label: 'Doubao Seedream 5.0 Lite' },
    { value: 'doubao-seedream-3-0-t2i-250415', label: 'Doubao Seedream 3.0 (仅文生图)' },
  ],
}

interface ArkProviderCardProps {
  relays: CustomRelay[]
  onSaved: () => void
}

function ArkProviderCard({ relays, onSaved }: ArkProviderCardProps) {
  const queryClient = useQueryClient()

  // Detect existing ark config to prefill
  const existing = {
    chat: relays.find((r) => r.name === ARK_RELAY_NAMES.chat),
    embedding: relays.find((r) => r.name === ARK_RELAY_NAMES.embedding),
    image: relays.find((r) => r.name === ARK_RELAY_NAMES.image),
  }
  const existingKey = existing.chat?.api_key || existing.embedding?.api_key || existing.image?.api_key || ''
  const isConfigured = existingKey && existingKey !== '****' && existingKey.length > 4

  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [chatModel, setChatModel] = useState(existing.chat?.model || ARK_MODEL_OPTIONS.chat[0].value)
  const [embeddingModel, setEmbeddingModel] = useState(existing.embedding?.model || ARK_MODEL_OPTIONS.embedding[0].value)
  const [imageModel, setImageModel] = useState(existing.image?.model || ARK_MODEL_OPTIONS.image[0].value)
  const [autoAssign, setAutoAssign] = useState(true)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null)

  const effectiveKey = apiKey || (isConfigured ? existingKey : '')

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveKey) throw new Error('请先填入 Ark API Key')

      // 1. Replace any existing ark-* relays with fresh entries
      const others = relays.filter((r) => !Object.values(ARK_RELAY_NAMES).includes(r.name as any))
      const fresh: CustomRelay[] = [
        { name: ARK_RELAY_NAMES.chat, base_url: ARK_BASE_URL, api_key: effectiveKey, model: chatModel, capabilities: ['打标', '描述'] },
        { name: ARK_RELAY_NAMES.embedding, base_url: ARK_BASE_URL, api_key: effectiveKey, model: embeddingModel, capabilities: ['向量化'] },
        { name: ARK_RELAY_NAMES.image, base_url: ARK_BASE_URL, api_key: effectiveKey, model: imageModel, capabilities: ['生成', '编辑'] },
      ]
      const updated = [...others, ...fresh]

      const payload: Record<string, string> = { custom_relays: JSON.stringify(updated) }
      if (autoAssign) {
        payload.default_general_provider = `relay:${ARK_RELAY_NAMES.chat}`
        payload.default_image_provider = `relay:${ARK_RELAY_NAMES.image}`
        payload.default_image_embedding_provider = `relay:${ARK_RELAY_NAMES.embedding}`
      }
      return api.config.update(payload)
    },
    onSuccess: () => {
      toast.success(autoAssign ? 'Ark 已配置并设为默认 provider' : 'Ark 配置已保存')
      setApiKey('')
      onSaved()
      queryClient.invalidateQueries({ queryKey: ['available-providers'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const removeMutation = useMutation({
    mutationFn: () => {
      const others = relays.filter((r) => !Object.values(ARK_RELAY_NAMES).includes(r.name as any))
      return api.config.update({ custom_relays: JSON.stringify(others) })
    },
    onSuccess: () => { toast.success('已移除 Ark 配置'); onSaved() },
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      // Prefer stable relay-name lookup so the backend reads the real
      // (unmasked) api_key from disk. Array indexes can drift after another
      // device inserts/reorders relays and would test the wrong token.
      let body: Record<string, unknown>
      if (apiKey) {
        body = {
          provider_id: 'openai_compatible',
          base_url: ARK_BASE_URL,
          api_key: apiKey,
          model: chatModel,
        }
      } else {
        const saved = relays.some((r) => r.name === ARK_RELAY_NAMES.chat)
        if (!saved) {
          setTestResult({ ok: false, error: '请先填入 API Key' })
          return
        }
        body = { provider_id: 'openai_compatible', provider_name: ARK_RELAY_NAMES.chat }
      }
      const res = await apiFetchRaw('/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setTestResult(await res.json())
    } catch {
      setTestResult({ ok: false, error: '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[13px] font-semibold text-foreground/70">火山方舟 Ark · 一站式配置</h2>
        <a
          href="https://www.volcengine.com/docs/82379/1362931"
          target="_blank" rel="noreferrer"
          className="text-[11px] text-foreground/45 hover:text-foreground/70 inline-flex items-center gap-0.5"
        >
          官方文档 <ExternalLink size={10} />
        </a>
      </div>
      <div className="rounded-lg border border-foreground/8 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-foreground/85">Volcengine Ark</h3>
          <InfoHint text={
            '一个 API Key 同时配置三类模型：通用对话/视觉、多模态嵌入（去重）、Seedream 图像生成。\n' +
            '保存后会自动写入 3 条 relay：ark-chat / ark-embedding / ark-image。'
          } />
          {isConfigured && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              <CheckCircle size={10} className="mr-1 text-success" /> 已配置
            </Badge>
          )}
          <span className="ml-auto text-[10px] text-foreground/40 font-mono">{ARK_BASE_URL}</span>
        </div>

        {/* API Key */}
        <div className="flex gap-2 items-start">
          <label className="text-[12px] text-foreground/55 w-20 shrink-0 pt-1.5">API Key</label>
          <div className="relative flex-1">
            <Input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isConfigured ? `已配置 (${existingKey.slice(0, 8)}...)` : 'sk-xxx 或 ARK API Key'}
              className="h-8 text-[13px] pr-8"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/30 hover:text-foreground/60"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Model selectors */}
        <ModelRow
          label="通用 / 视觉"
          value={chatModel} onChange={setChatModel}
          options={ARK_MODEL_OPTIONS.chat}
        />
        <ModelRow
          label="多模态嵌入"
          value={embeddingModel} onChange={setEmbeddingModel}
          options={ARK_MODEL_OPTIONS.embedding}
        />
        <ModelRow
          label="图像生成"
          value={imageModel} onChange={setImageModel}
          options={ARK_MODEL_OPTIONS.image}
        />

        <label className="flex items-start gap-2 text-[11px] text-foreground/55 cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={autoAssign}
            onChange={(e) => setAutoAssign(e.target.checked)}
            className="mt-0.5"
          />
          保存后自动设为「通用 / 嵌入 / 图像生成」三个角色的默认 provider
        </label>

        {testResult && (
          <p className={cn('text-[11px]', testResult.ok ? 'text-success' : 'text-destructive')}>
            {testResult.ok ? testResult.message : testResult.error}
          </p>
        )}

        <div className="flex gap-2 justify-end pt-1">
          {isConfigured && (
            <Button
              variant="ghost" size="sm" className="h-7 text-[11px] text-destructive mr-auto"
              onClick={() => { if (confirm('移除全部 Ark 配置？')) removeMutation.mutate() }}
            >
              <Trash2 size={11} className="mr-1" /> 移除
            </Button>
          )}
          <Button
            variant="ghost" size="sm" className="h-7 text-[12px]"
            disabled={testing || !effectiveKey}
            onClick={handleTest}
          >
            {testing && <Loader2 size={12} className="animate-spin mr-1" />}
            测试连接
          </Button>
          <Button
            variant="default" size="sm" className="h-7 text-[12px]"
            disabled={!effectiveKey || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </section>
  )
}

function ModelRow({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  const isCustom = !options.find((o) => o.value === value)
  return (
    <div className="flex gap-2 items-center">
      <label className="text-[12px] text-foreground/55 w-20 shrink-0">{label}</label>
      <div className="flex-1 flex gap-2">
        <select
          value={isCustom ? '__custom__' : value}
          onChange={(e) => {
            if (e.target.value === '__custom__') return
            onChange(e.target.value)
          }}
          className="flex-1 h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px] truncate"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          <option value="__custom__">自定义模型 / 接入点 ID …</option>
        </select>
        {isCustom && (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="ep-xxxxx 或自定义 model id"
            className="h-8 text-[12px] font-mono w-56"
          />
        )}
      </div>
    </div>
  )
}


// ── Tagger A/B Audit ─────────────────────────────────────────────────────────
//
// Cross-validate a fraction of newly-tagged images against a stronger provider
// and surface the agreement score. Helps catch silent regressions when you
// switch the primary tagger to a cheaper model.

interface AuditStats {
  enabled: boolean
  audit_provider: string | null
  sample_rate: number | null
  total: number
  ok: number
  mismatch: number
  error: number
  avg_jaccard: number | null
  per_dimension_avg: Record<string, number>
  window_hours: number
}

function TaggerAuditCard({ config, onSaved }: {
  config: Record<string, string>
  onSaved: () => void
}) {
  const queryClient = useQueryClient()
  const [auditProvider, setAuditProvider] = useState<string>(config.tagger_audit_provider || '')
  const [sampleRate, setSampleRate] = useState<string>(
    String(config.tagger_audit_sample_rate ?? '0.05'),
  )
  const [auditModel, setAuditModel] = useState<string>(config.tagger_audit_model_override || '')

  const { data: providers } = useQuery<AvailableProvider[]>({
    queryKey: ['available-providers'],
    queryFn: () => apiFetchRaw('/providers/available').then((r) => r.json()),
  })

  const { data: stats } = useQuery<AuditStats>({
    queryKey: ['tagger-audit-stats'],
    queryFn: () => apiFetchRaw('/audit/tagger/stats').then((r) => r.json()),
    refetchInterval: 10000,
  })

  const save = useMutation({
    mutationFn: () => api.config.update({
      tagger_audit_provider: auditProvider,
      tagger_audit_sample_rate: Number(sampleRate) || 0,
      tagger_audit_model_override: auditModel,
    }),
    onSuccess: () => {
      toast.success('审计设置已保存')
      onSaved()
      queryClient.invalidateQueries({ queryKey: ['tagger-audit-stats'] })
    },
  })

  const dirty =
    auditProvider !== (config.tagger_audit_provider || '') ||
    Number(sampleRate) !== Number(config.tagger_audit_sample_rate ?? 0.05) ||
    auditModel !== (config.tagger_audit_model_override || '')

  const ratePct = stats?.avg_jaccard != null ? Math.round(stats.avg_jaccard * 100) : null
  const rateColor = ratePct == null ? 'text-foreground/40'
    : ratePct >= 85 ? 'text-success'
    : ratePct >= 65 ? 'text-warning'
    : 'text-destructive'

  return (
    <section>
      <div className="flex items-center gap-1.5 mb-3">
        <ShieldCheck size={13} className="text-foreground/55" />
        <h2 className="text-[13px] font-semibold text-foreground/70">打标质量审计</h2>
        <InfoHint text="随机抽样用更强的 provider 复核打标结果，自动计算 Jaccard 一致性。" />
      </div>

      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-4 space-y-3">
        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3 pb-3 border-b border-foreground/5">
          <Stat label="平均一致性" value={ratePct != null ? `${ratePct}%` : '—'} valueClass={rateColor} />
          <Stat label="样本数" value={String(stats?.total ?? 0)} />
          <Stat
            label="一致 / 不一致"
            value={`${stats?.ok ?? 0} / ${stats?.mismatch ?? 0}`}
            valueClass={stats && stats.mismatch > 0 ? 'text-warning' : ''}
          />
          <Stat label="窗口" value={`${stats?.window_hours ?? 168}h`} />
        </div>

        {/* Per-dimension breakdown */}
        {stats && Object.keys(stats.per_dimension_avg ?? {}).length > 0 && (
          <div className="text-[11px] text-foreground/55 space-y-1">
            <div className="text-foreground/40 mb-0.5">分维度一致性</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(stats.per_dimension_avg).map(([dim, j]) => (
                <span key={dim} className="font-mono">
                  {dim}: <span className={j >= 0.85 ? 'text-success' : j >= 0.65 ? 'text-warning' : 'text-destructive'}>
                    {Math.round(j * 100)}%
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Config */}
        <div className="space-y-2 pt-2">
          <div className="flex gap-2 items-center">
            <label className="text-[12px] text-foreground/60 w-24 shrink-0">审计 provider</label>
            <select
              value={auditProvider}
              onChange={(e) => setAuditProvider(e.target.value)}
              className="flex-1 h-8 rounded-md border border-foreground/15 bg-background px-2 text-[12px]"
            >
              <option value="">— 关闭审计 —</option>
              {providers?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.model ? ` · ${p.model}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            <label className="text-[12px] text-foreground/60 w-24 shrink-0">抽样率</label>
            <Input
              type="number" min={0} max={1} step={0.01}
              value={sampleRate}
              onChange={(e) => setSampleRate(e.target.value)}
              className="w-24 h-8 text-[12px] font-mono"
            />
            <span className="text-[10.5px] text-foreground/40">
              0.05 = 5%（每 100 张抽 5 张复核）
            </span>
          </div>
          <div className="flex gap-2 items-center">
            <label className="text-[12px] text-foreground/60 w-24 shrink-0">模型覆盖</label>
            <Input
              value={auditModel}
              onChange={(e) => setAuditModel(e.target.value)}
              placeholder="可选，默认使用 provider 配置的模型"
              className="flex-1 h-8 text-[12px] font-mono"
            />
          </div>
        </div>

        {stats && stats.mismatch > 0 && (
          <div className="text-[11px] text-warning flex items-start gap-1.5 bg-warning/5 p-2 rounded">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>
              检测到 {stats.mismatch} 张图片的打标结果与审计 provider 显著不一致（一致性 &lt; 60%）。
              建议：调高主 provider 的模型规格，或检查标签体系是否过于细致。
            </span>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            size="sm" className="h-7 text-[12px]"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            保存审计设置
          </Button>
        </div>
      </div>
    </section>
  )
}

function Stat({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className="text-[10.5px] text-foreground/40">{label}</div>
      <div className={cn('text-[14px] font-semibold mt-0.5', valueClass || 'text-foreground/85')}>{value}</div>
    </div>
  )
}
