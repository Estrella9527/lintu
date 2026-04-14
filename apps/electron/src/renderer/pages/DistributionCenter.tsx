import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { Cloud, Key, Globe, History, Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'

const TABS = [
  { id: 'api', label: 'Open API', icon: Globe },
  { id: 'oss', label: 'OSS同步', icon: Cloud },
  { id: 'history', label: '操作日志', icon: History },
]

const API_BASE = 'http://localhost:7879'

const API_DOCS = [
  {
    method: 'GET',
    path: '/open-api/images',
    description: '获取图片列表（带筛选、分页）',
    params: 'project_id, source_type, scene[], season[], offset, limit',
    example: '/open-api/images?source_type=original&limit=10',
  },
  {
    method: 'GET',
    path: '/open-api/images/{id}',
    description: '获取单张图片详情 + 标签',
    params: 'id (path)',
    example: '/open-api/images/{image_id}',
  },
  {
    method: 'GET',
    path: '/open-api/images/{id}/file',
    description: '获取图片文件（原图或缩略图）',
    params: 'size (可选: 128/300/800)',
    example: '/open-api/images/{image_id}/file?size=300',
  },
  {
    method: 'GET',
    path: '/open-api/tags',
    description: '获取标签分布统计',
    params: 'project_id, dimension',
    example: '/open-api/tags?dimension=scene',
  },
  {
    method: 'GET',
    path: '/open-api/stats',
    description: '获取汇总统计（总量/通过/生成/打标）',
    params: 'project_id',
    example: '/open-api/stats',
  },
]

function OpenAPITab() {
  const { data: stats } = useQuery({
    queryKey: ['open-api-stats'],
    queryFn: () => fetch(`${API_BASE}/open-api/stats`).then((r) => r.json()),
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
            {API_BASE}/open-api
          </code>
          <Button variant="outline" size="sm" className="h-8" onClick={() => copyUrl('/open-api')}>
            <Copy size={12} className="mr-1" /> 复制
          </Button>
        </div>
        <p className="text-[11px] text-foreground/30 mt-2">
          外部系统通过此地址访问图片资源。生产环境中建议配置反向代理和 API Key 鉴权。
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
            onClick={() => window.open(`${API_BASE}/open-api/images?limit=5`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> 图片列表
          </Button>
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/open-api/tags`, '_blank')}
          >
            <ExternalLink size={12} className="mr-1" /> 标签分布
          </Button>
          <Button
            variant="outline" size="sm" className="text-[12px]"
            onClick={() => window.open(`${API_BASE}/open-api/stats`, '_blank')}
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
  const [activeTab, setActiveTab] = useState('api')

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
        {activeTab === 'api' && <OpenAPITab />}
        {activeTab === 'oss' && (
          <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
            OSS 同步功能开发中
          </div>
        )}
        {activeTab === 'history' && (
          <div className="flex items-center justify-center h-64 text-[13px] text-foreground/30 rounded-lg border border-dashed border-foreground/10">
            操作日志功能开发中
          </div>
        )}
      </div>
    </div>
  )
}
