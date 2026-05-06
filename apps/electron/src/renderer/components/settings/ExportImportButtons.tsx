/**
 * Reusable 导出 / 导入 button pair for Settings tabs.
 *
 * Backend contract: GET <exportUrl> returns the JSON we save to disk;
 * POST <importUrl> consumes a JSON body. The exported JSON is fed
 * straight back to the import endpoint after an optional shape adjust
 * via `importBodyAdapter` (used by tag-schema where the export key is
 * `schema` but the import body key is `schema_data` to dodge Pydantic's
 * reserved-name warning).
 *
 * Sensitive blobs (provider config with real keys) are guarded by an
 * optional confirm prompt — the caller passes `confirmExportSecrets:
 * true` and we ask before adding `?include_secrets=true` to the URL.
 */
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Download, Upload } from 'lucide-react'

const API_BASE = 'http://localhost:7879/api'

type Props = {
  /** Path under /api, e.g. '/tag-schema/export'. Leading slash optional. */
  exportPath: string
  /** Path under /api, e.g. '/tag-schema/import'. Leading slash optional. */
  importPath: string
  /** Filename suggested to the user when they download the export. */
  exportFilename: string
  /** Display label, e.g. '标签体系'. */
  domainLabel: string
  /** Optional body adapter — JSON arriving from import file gets rewritten
   *  before POST. Default is identity (post the parsed JSON as-is). */
  importBodyAdapter?: (parsed: any) => any
  /** Called after successful import so the parent can refetch / refresh. */
  onImportDone?: () => void
  /** When true, show a confirm dialog before exporting; passes
   *  `?include_secrets=true`. Used by AI providers. */
  exportSecretsToggle?: boolean
}

export function ExportImportButtons({
  exportPath,
  importPath,
  exportFilename,
  domainLabel,
  importBodyAdapter,
  onImportDone,
  exportSecretsToggle,
}: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)

  const handleExport = async () => {
    setBusy(true)
    try {
      let url = `${API_BASE}${exportPath.startsWith('/') ? exportPath : '/' + exportPath}`
      if (exportSecretsToggle) {
        const includeSecrets = window.confirm(
          `导出 ${domainLabel} 是否包含明文 api_key？\n\n` +
          `点「确定」: 导出真实凭据（仅用于完全信任的目标机器，文件勿贴公网）。\n` +
          `点「取消」: 凭据被 mask 成 sk-X****，目标机需手动补 key。`,
        )
        if (includeSecrets) url += url.includes('?') ? '&include_secrets=true' : '?include_secrets=true'
      }
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = exportFilename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
      toast.success(`已导出 ${domainLabel}`)
    } catch (e: any) {
      toast.error(`导出失败：${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  const handleImportClick = () => fileRef.current?.click()

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''  // reset so re-picking same file fires onChange
    if (!file) return
    setBusy(true)
    try {
      const text = await file.text()
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('文件不是合法 JSON')
      }
      const body = importBodyAdapter ? importBodyAdapter(parsed) : parsed
      const url = `${API_BASE}${importPath.startsWith('/') ? importPath : '/' + importPath}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(() => null)
      if (!r.ok || (data && data.ok === false)) {
        throw new Error(data?.error || `HTTP ${r.status}`)
      }
      // Format result summary
      const summary = formatImportResult(domainLabel, data)
      toast.success(summary)
      onImportDone?.()
    } catch (e: any) {
      toast.error(`导入失败：${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={handleExport} disabled={busy} title={`导出 ${domainLabel} 到 JSON 文件`}>
        <Download size={13} className="mr-1" /> 导出
      </Button>
      <Button variant="ghost" size="sm" onClick={handleImportClick} disabled={busy} title={`从 JSON 文件导入 ${domainLabel}`}>
        <Upload size={13} className="mr-1" /> 导入
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileSelected}
        hidden
      />
    </div>
  )
}

function formatImportResult(domainLabel: string, data: any): string {
  if (!data) return `${domainLabel}: 已导入`
  // prompts case
  if (typeof data.created === 'number' || typeof data.updated === 'number') {
    const parts: string[] = []
    if (data.created) parts.push(`新建 ${data.created}`)
    if (data.updated) parts.push(`更新 ${data.updated}`)
    if (data.skipped) parts.push(`跳过 ${data.skipped}`)
    if (data.invalid) parts.push(`无效 ${data.invalid}`)
    return `${domainLabel}: ${parts.join(' / ') || '无变更'}`
  }
  // tag-schema case
  if (typeof data.dimensions_after === 'number') {
    return `${domainLabel}: 维度 ${data.dimensions_after}, 取值 ${data.values_after}`
  }
  // providers case
  if (typeof data.relays_added === 'number') {
    const a = data.relays_added, u = data.relays_updated, k = data.keys_touched
    return `${domainLabel}: relay 新增 ${a}, 更新 ${u}, 共触及 ${k} 项`
  }
  return `${domainLabel}: 已导入`
}
