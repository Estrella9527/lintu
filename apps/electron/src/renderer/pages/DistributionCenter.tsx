import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'

import { distributionNavRequestAtom } from '@/atoms/navigation'
import { distributionActiveTabAtom } from '@/atoms/ui-state'
import { cn } from '@/lib/utils'
import { Cloud, Key, Globe, History, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { ApiKeyTab } from '@/components/distribution/ApiKeyTab'
import { OssSyncTab } from '@/components/distribution/OssSyncTab'
import { RequestLogTab } from '@/components/distribution/RequestLogTab'

const TABS = [
  { id: 'keys', label: 'API Keys', icon: Key },
  { id: 'api', label: '接口文档', icon: Globe },
  { id: 'history', label: '调用日志', icon: History },
  { id: 'oss', label: 'OSS同步', icon: Cloud },
]

const API_BASE = 'http://localhost:7879'

const API_DOCS = [
  {
    method: 'GET',
    path: '/open-api/v1/health',
    description: '健康检查（公开，无需鉴权）',
    params: '—',
    example: '/open-api/v1/health',
  },
  {
    method: 'GET',
    path: '/open-api/v1/images',
    description: '图片列表（筛选、分页）',
    params: 'project_id, source_type, scene[], season[], offset, limit',
    example: '/open-api/v1/images?source_type=original&limit=10',
  },
  {
    method: 'GET',
    path: '/open-api/v1/images/{id}',
    description: '单张图片详情 + 标签',
    params: 'id (path)',
    example: '/open-api/v1/images/{image_id}',
  },
  {
    method: 'GET',
    path: '/open-api/v1/images/{id}/derivatives',
    description: '该种子图的所有衍生图',
    params: 'id (path)',
    example: '/open-api/v1/images/{image_id}/derivatives',
  },
  {
    method: 'GET',
    path: '/open-api/v1/images/{id}/file',
    description: '图片文件（原图或 thumbnail）',
    params: 'size (可选: 128/300/800)',
    example: '/open-api/v1/images/{image_id}/file?size=300',
  },
  {
    method: 'GET',
    path: '/open-api/v1/tags',
    description: '标签分布统计',
    params: 'project_id, dimension',
    example: '/open-api/v1/tags?dimension=scene',
  },
  {
    method: 'GET',
    path: '/open-api/v1/stats',
    description: '汇总统计（总量/通过/生成/打标）',
    params: 'project_id',
    example: '/open-api/v1/stats',
  },
  {
    method: 'GET',
    path: '/open-api/v1/matrix',
    description: '覆盖矩阵（行 × 列 标签维度）',
    params: 'project_id, row, col',
    example: '/open-api/v1/matrix?project_id=xxx&row=scene&col=season',
  },
  {
    method: 'GET',
    path: '/open-api/v1/batches',
    description: '批次列表（只读）',
    params: 'project_id, status',
    example: '/open-api/v1/batches',
  },
  {
    method: 'POST',
    path: '/open-api/v1/batches',
    description: '提交批次（需 generate:write 权限）',
    params: 'JSON: { name, task_type, seed_image_ids, prompt_ids, project_id }',
    example: '/open-api/v1/batches',
  },
]

function OpenAPITab() {
  const { data: stats } = useQuery({
    queryKey: ['open-api-stats'],
    queryFn: () => fetch(`${API_BASE}/open-api/v1/stats`).then((r) => r.json()),
  })

  const copyUrl = (path: string) => {
    navigator.clipboard.writeText(`${API_BASE}${path}`)
    toast.success('已复制到剪贴板')
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Status */}
      <div className="rounded-lg border border-foreground/5 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[13px] font-medium text-foreground/80">API 服务状态</h3>
          <Badge variant="secondary" className="text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-success mr-1.5 inline-block" />
            运行中
          </Badge>
        </div>
        <div className="grid grid-cols-4 gap-3 text-[12px]">
          <div className="rounded-md bg-foreground/[0.02] p-2 text-center">
            <div className="text-[18px] font-semibold text-foreground/70 tabular-nums">{stats?.total_images ?? '—'}</div>
            <div className="text-foreground/40">总图片</div>
          </div>
          <div className="rounded-md bg-foreground/[0.02] p-2 text-center">
            <div className="text-[18px] font-semibold text-foreground/70 tabular-nums">{stats?.passed ?? '—'}</div>
            <div className="text-foreground/40">已通过</div>
          </div>
          <div className="rounded-md bg-foreground/[0.02] p-2 text-center">
            <div className="text-[18px] font-semibold text-foreground/70 tabular-nums">{stats?.generated ?? '—'}</div>
            <div className="text-foreground/40">生成图</div>
          </div>
          <div className="rounded-md bg-foreground/[0.02] p-2 text-center">
            <div className="text-[18px] font-semibold text-foreground/70 tabular-nums">{stats?.tagged ?? '—'}</div>
            <div className="text-foreground/40">已打标</div>
          </div>
        </div>
      </div>

      {/* Base URL */}
      <div className="rounded-lg border border-foreground/5 p-4">
        <h3 className="text-[13px] font-medium text-foreground/80 mb-2">Base URL</h3>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded-md bg-foreground/[0.03] text-[13px] font-mono text-foreground/70">
            {API_BASE}/open-api/v1
          </code>
          <Button variant="outline" size="sm" className="h-8" onClick={() => copyUrl('/open-api/v1')}>
            <Copy size={12} className="mr-1" /> 复制
          </Button>
        </div>
        <p className="text-[11px] text-foreground/30 mt-2">
          外部系统通过此地址访问图片资源。<strong>服务器模式</strong>需在请求头携带
          <code className="mx-1 px-1 bg-foreground/[0.04] rounded">Authorization: Bearer lk_live_xxx.&lt;secret&gt;</code>
          鉴权；本地 Electron 模式无需鉴权。
        </p>
      </div>

      {/* API Endpoints */}
      <div>
        <h3 className="text-[13px] font-medium text-foreground/80 mb-3">接口列表</h3>
        <div className="space-y-2">
          {API_DOCS.map((api) => (
            <div key={api.path} className="rounded-lg border border-foreground/5 p-3 hover:border-foreground/10 transition-colors">
              <div className="flex items-center gap-2 mb-1">
                <Badge variant={api.method === 'GET' ? 'secondary' : 'default'} className="text-[10px] px-1.5 py-0 font-mono">
                  {api.method}
                </Badge>
                <code className="text-[12px] font-mono text-accent">{api.path}</code>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0 ml-auto" onClick={() => copyUrl(api.example)}>
                  <Copy size={10} />
                </Button>
              </div>
              <p className="text-[12px] text-foreground/60">{api.description}</p>
              <p className="text-[11px] text-foreground/30 mt-1">参数: {api.params}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Quick test */}
      <div className="rounded-lg border border-foreground/5 p-4">
        <h3 className="text-[13px] font-medium text-foreground/80 mb-2">快速测试</h3>
        <div className="flex gap-2">
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/open-api/v1/images?limit=5`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> 图片列表
          </Button>
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/open-api/v1/tags`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> 标签分布
          </Button>
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/open-api/v1/stats`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> 统计概览
          </Button>
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/docs`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> Swagger 文档
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function DistributionCenter() {
  const [activeTab, setActiveTab] = useAtom(distributionActiveTabAtom)
  const [logsInitialKeyId, setLogsInitialKeyId] = useState<string | undefined>(undefined)

  // 'analytics' tab was moved to 匹配实验室. Self-heal stale atom value
  // from this session so we don't render an empty tab body.
  useEffect(() => {
    if (activeTab === 'analytics') setActiveTab('keys')
  }, [activeTab, setActiveTab])

  // Apply cross-page deep-link request (from ApiKeyTab "查看日志" button)
  const [navRequest, setNavRequest] = useAtom(distributionNavRequestAtom)
  useEffect(() => {
    if (!navRequest) return
    if (navRequest.tab) setActiveTab(navRequest.tab)
    if (navRequest.filterKeyId !== undefined) setLogsInitialKeyId(navRequest.filterKeyId)
    setNavRequest(null)
  }, [navRequest, setNavRequest])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 h-[48px] shrink-0 border-b border-foreground/5">
        <h1 className="text-[15px] font-semibold text-foreground">分发中心</h1>
      </div>
      <div className="px-6 pt-3 shrink-0">
        <div className="flex gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors',
                  activeTab === tab.id
                    ? 'bg-accent/10 text-accent'
                    : 'text-foreground/60 hover:text-foreground/80 hover:bg-foreground/[0.03]',
                )}
              >
                <Icon size={14} strokeWidth={1.5} />
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
        {activeTab === 'keys' && <ApiKeyTab />}
        {activeTab === 'api' && <OpenAPITab />}
        {activeTab === 'history' && <RequestLogTab initialKeyId={logsInitialKeyId} />}
        {activeTab === 'oss' && <OssSyncTab />}
      </div>
    </div>
  )
}
