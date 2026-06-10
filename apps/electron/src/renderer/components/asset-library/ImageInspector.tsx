import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'

import { api, apiFetchRaw } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Cpu, Download, Eye, FolderOpen, GitFork, PenTool, Rocket, Sparkles, Trash2 } from 'lucide-react'
import { ThumbnailImage } from './ThumbnailImage'
import { activeModuleAtom, assetLibraryNavRequestAtom } from '@/atoms/navigation'
import { batchSeedQueueAtom } from '@/atoms/workshop'
import type { ImageRecord, TagRecord } from '@/lib/types'

interface ImageInspectorProps {
  image: ImageRecord | null
  /** Open the lightbox for the current image (Eagle: spacebar / 预览 button) */
  onPreview?: (image: ImageRecord) => void
}

/** Eagle-style persistent right-side detail panel.
 *
 * Replaces the modal Drawer for browsing flow. Click any thumbnail in the
 * grid → this updates with that image's metadata. Spacebar (handled at the
 * page level) opens the full Lightbox preview.
 */
export function ImageInspector({ image, onPreview }: ImageInspectorProps) {
  const queryClient = useQueryClient()
  const setActiveModule = useSetAtom(activeModuleAtom)
  const setSeedQueue = useSetAtom(batchSeedQueueAtom)
  const setAssetNav = useSetAtom(assetLibraryNavRequestAtom)

  const { data: detail } = useQuery({
    queryKey: ['image-detail', image?.id],
    queryFn: () => api.images.get(image!.id),
    enabled: !!image,
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetchRaw(`/images/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    onSuccess: () => {
      toast.success('图片已删除')
      queryClient.invalidateQueries({ queryKey: ['images'] })
      queryClient.invalidateQueries({ queryKey: ['image-folders'] })
    },
  })

  if (!image) {
    return (
      <aside className="w-[280px] shrink-0 border-l border-foreground/5 flex items-center justify-center text-[12px] text-foreground/35 px-6 text-center">
        <p>选中一张图片查看详情<br /><span className="text-[10px] mt-1 inline-block opacity-70">按 <kbd className="px-1 py-0.5 rounded bg-foreground/10 text-foreground/60">Space</kbd> 进入预览</span></p>
      </aside>
    )
  }

  const img = detail || image

  const handleDownload = async () => {
    const url = api.images.downloadUrl(img.id)
    const saved = await window.electronAPI.downloadFile(url, img.file_name)
    if (saved) toast.success(`已保存到 ${saved}`)
  }
  const handleExportSvg = async () => {
    toast.message('正在矢量化…', { description: '首次转换需要几秒;适合 logo/插画,照片会呈色块矢量风' })
    const stem = (img.file_name || img.id).replace(/\.[^.]+$/, '')
    const saved = await window.electronAPI.downloadFile(api.images.svgUrl(img.id), `${stem}.svg`)
    if (saved) toast.success(`SVG 已导出到 ${saved}`)
  }
  const handleOpenFile = () => {
    if (img.file_path) window.electronAPI.openFile(img.file_path)
  }
  const handleSeedNewBatch = () => {
    setSeedQueue([img])
    setActiveModule('ai-workshop')
  }
  const handleViewDerivatives = () => {
    setAssetNav({
      tab: 'all',
      source: 'generated',
      parentId: img.id,
      parentLabel: img.file_name,
    })
  }
  const derivativeCount = (img as any).derivatives_count ?? null

  return (
    <aside className="w-[280px] shrink-0 border-l border-foreground/5 overflow-y-auto">
      <div className="p-3.5 space-y-3.5">
        {/* Preview thumbnail */}
        <div
          className="rounded-md overflow-hidden bg-foreground/[0.04] cursor-zoom-in group relative"
          onClick={() => onPreview?.(img)}
          title="点击或按 Space 打开大图预览"
        >
          <ThumbnailImage
            imageId={img.id}
            size={800}
            version={img.updated_at}
            className="w-full aspect-[4/3]"
          />
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
            <Eye size={24} className="text-white drop-shadow" />
          </div>
        </div>

        {/* Filename + size headline */}
        <div>
          <h3 className="text-[13px] font-medium text-foreground/85 break-all leading-tight">
            {img.file_name}
          </h3>
          <p className="text-[11px] text-foreground/45 mt-1 tabular-nums">
            {img.width && img.height ? `${img.width} × ${img.height}` : ''}
            {img.file_size_kb ? `  ·  ${formatSize(img.file_size_kb)}` : ''}
          </p>
        </div>

        {/* Action row */}
        <div className="grid grid-cols-4 gap-1">
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-1" onClick={handleDownload}>
            <Download size={11} className="mr-1" /> 下载
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-1" onClick={handleExportSvg}
            title="位图转矢量(SVG);适合 logo/插画/海报元素">
            <PenTool size={11} className="mr-1" /> SVG
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[11px] px-1" onClick={handleOpenFile}>
            <FolderOpen size={11} className="mr-1" /> 原文件
          </Button>
          <Button
            variant="outline" size="sm"
            className="h-7 text-[11px] px-1 text-destructive border-destructive/30"
            onClick={() => { if (confirm('确定删除？')) deleteMutation.mutate(img.id) }}
          >
            <Trash2 size={11} className="mr-1" /> 删除
          </Button>
        </div>

        {/* Workflow shortcuts: seed new batch + jump to derivatives. */}
        <div className="grid grid-cols-2 gap-1">
          <Button
            variant="outline" size="sm"
            className="h-7 text-[11px] px-1"
            onClick={handleSeedNewBatch}
            title="把这张图作为种子，进入 AI 工坊批量生产"
          >
            <Rocket size={11} className="mr-1" /> 作为种子开新批次
          </Button>
          <Button
            variant="outline" size="sm"
            className="h-7 text-[11px] px-1"
            onClick={handleViewDerivatives}
            title="查看以此图为种子生成的所有衍生图"
          >
            <GitFork size={11} className="mr-1" />
            看衍生图{derivativeCount != null ? ` (${derivativeCount})` : ''}
          </Button>
        </div>

        <Separator />

        {/* File info */}
        <Section title="文件信息">
          <Row label="来源" value={img.source_type === 'generated' ? 'AI 生成' : '原始图片'} />
          <Row label="质检" value={
            img.quality_status === 'passed' ? '✓ 通过' :
            img.quality_status === 'rejected' ? `✗ 淘汰 (${img.reject_reason || ''})` : '待检'
          } />
          <Row label="清晰度" value={img.blur_score != null ? img.blur_score.toFixed(1) : '—'} />
          <Row label="亮度" value={img.brightness != null ? img.brightness.toFixed(1) : '—'} />
          <Row label="文件夹" value={img.relative_dir || '根目录'} />
          <Row label="入库时间" value={img.created_at ? new Date(img.created_at).toLocaleString('zh-CN') : '—'} />
        </Section>

        {/* AI generation provenance */}
        {img.source_type === 'generated' && img.generation_metadata && (
          <>
            <Separator />
            <Section title={<><Sparkles size={11} className="inline -mt-0.5 mr-1 text-info" /> AI 生成信息</>}>
              <Row label="Provider" value={img.generation_metadata.provider || '—'} />
              <Row label="生成耗时" value={formatLatency(img.generation_metadata.latency_ms)} />
              <Row label="成本" value={img.generation_metadata.cost_usd != null ? `$${img.generation_metadata.cost_usd.toFixed(4)}` : '—'} />
              <Row label="重试" value={String(img.generation_metadata.retry_count ?? 0)} />
              <Row label="生成时间" value={img.generation_metadata.generated_at ? new Date(img.generation_metadata.generated_at).toLocaleString('zh-CN') : '—'} />
              <Row label="批次" value={img.generation_metadata.batch_name || '—'} />
              <Row label="种子图" value={img.generation_metadata.seed_file_name || '—'} />

              {img.generation_metadata.prompt_name && (
                <div className="col-span-2 mt-2 rounded-md border border-info/20 bg-info/[0.04] p-2.5">
                  <div className="flex items-center gap-1 mb-1">
                    <Cpu size={10} className="text-info" />
                    <span className="text-[10px] font-medium text-foreground/75">Prompt</span>
                    <Badge variant="secondary" className="text-[9px] px-1 py-0 ml-auto">
                      {img.generation_metadata.prompt_name}
                    </Badge>
                  </div>
                  {img.generation_metadata.prompt_content && (
                    <p className="text-[10px] text-foreground/55 leading-relaxed whitespace-pre-wrap line-clamp-6">
                      {img.generation_metadata.prompt_content}
                    </p>
                  )}
                </div>
              )}
            </Section>
          </>
        )}

        {/* Tags */}
        {detail?.tags && detail.tags.length > 0 && (
          <>
            <Separator />
            <Section title="标签">
              <div className="col-span-2 space-y-1.5">
                {Object.entries(groupTagsByDimension(detail.tags)).map(([dim, vals]) => (
                  <div key={dim} className="flex items-start gap-2">
                    <span className="text-[10px] text-foreground/40 w-12 shrink-0 pt-0.5">{dim}</span>
                    <div className="flex flex-wrap gap-1">
                      {vals.map((v) => (
                        <Badge key={v} variant="secondary" className="text-[10px] px-1.5 py-0">{v}</Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}

        {/* AI description */}
        {img.description && (
          <>
            <Separator />
            <Section title="AI 描述">
              <p className="col-span-2 text-[12px] text-foreground/65 leading-relaxed">{img.description}</p>
            </Section>
          </>
        )}

        {/* File path */}
        <Separator />
        <p className="text-[10px] text-foreground/30 break-all leading-snug">{img.file_path}</p>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="text-[11px] font-medium text-foreground/55 mb-2">{title}</h4>
      <div className="grid grid-cols-2 gap-y-1 gap-x-3 text-[11px]">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-foreground/40">{label}</span>
      <span className="text-foreground/80 truncate" title={value}>{value}</span>
    </>
  )
}

function formatSize(kb: number): string {
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

function formatLatency(ms?: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

function groupTagsByDimension(tags: TagRecord[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const t of tags) (groups[t.dimension] ??= []).push(t.value)
  return groups
}
