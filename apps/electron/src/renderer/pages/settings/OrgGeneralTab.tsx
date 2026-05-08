import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, Loader2, Save, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/shared/EmptyState'
import { activeOrgAtom, myOrgsAtom } from '@/atoms/auth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { ApiError, api } from '@/lib/api'
import { InfoHint } from '@/components/shared/InfoHint'
import { fileToAvatarDataUrl } from '@/lib/imageUtil'
import { cn } from '@/lib/utils'

/**
 * 组织设置 / 通用 — owner / admin 改组织名 / logo / 联系邮箱。
 *
 * 当前用户没权限或没选组织 → 显示提示。
 */
export function OrgGeneralTab() {
  const activeOrg = useAtomValue(activeOrgAtom)
  const [, setMyOrgs] = useAtom(myOrgsAtom)
  const user = useCurrentUser()
  const queryClient = useQueryClient()

  const [name, setName] = useState(activeOrg?.name ?? '')
  const [contactEmail, setContactEmail] = useState('')
  const [logoUrl, setLogoUrl] = useState('')
  const [processingLogo, setProcessingLogo] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 当 active org 切换时，重新加载表单
  useEffect(() => {
    setName(activeOrg?.name ?? '')
    setContactEmail('')
    setLogoUrl(activeOrg?.logo_url ?? '')
  }, [activeOrg?.id, activeOrg?.name, activeOrg?.logo_url])

  const handlePickLogo = () => fileInputRef.current?.click()

  const handleLogoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setProcessingLogo(true)
    try {
      const dataUrl = await fileToAvatarDataUrl(f, 256)
      setLogoUrl(dataUrl)
    } catch (err) {
      toast.error((err as Error).message || '图片处理失败')
    } finally {
      setProcessingLogo(false)
    }
  }

  const handleClearLogo = () => setLogoUrl('')

  const canEdit = !!user?.is_platform_owner ||
    activeOrg?.my_role === 'owner' ||
    activeOrg?.my_role === 'admin'

  const saveMutation = useMutation({
    mutationFn: () => api.orgs.update(activeOrg!.id, {
      name: name.trim() || undefined,
      contact_email: contactEmail.trim() || undefined,
      logo_url: logoUrl.trim() || undefined,
    }),
    onSuccess: async () => {
      try {
        const all = await api.orgs.list()
        setMyOrgs(all)
      } catch { /* ignore */ }
      queryClient.invalidateQueries()
      toast.success('组织设置已保存')
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`保存失败：${msg}`)
    },
  })

  if (!activeOrg) {
    return (
      <div className="max-w-xl">
        <EmptyState
          icon={Building2}
          title="未选择组织"
          description="先在左下角组织切换器选一个组织，再来改设置"
        />
      </div>
    )
  }

  return (
    <div className="space-y-5 max-w-xl">
      {/* 概览卡片 */}
      <div className="rounded-lg border border-foreground/8 bg-foreground/[0.015] p-4 flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent/70 text-background overflow-hidden">
          {activeOrg.logo_url
            ? <img src={activeOrg.logo_url} alt="" className="h-full w-full object-cover" />
            : <Building2 size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-foreground/85">{activeOrg.name}</div>
          <div className="text-[11px] text-foreground/55">
            slug: <code className="font-mono">{activeOrg.slug}</code> ·
            套餐 {activeOrg.plan} ·
            存储 {activeOrg.storage_used_gb.toFixed(1)} / {activeOrg.storage_quota_gb} GB
          </div>
          <div className="text-[10.5px] text-foreground/45 mt-0.5">
            {activeOrg.member_count} 个成员 · {activeOrg.project_count} 个项目
          </div>
        </div>
      </div>

      {!canEdit && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-400">
          仅组织 owner / admin 可改设置；你的角色是「成员」。
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-[12px]">组织名称</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit || saveMutation.isPending}
            className="h-9 text-[12.5px]"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[12px]">联系邮箱</Label>
          <Input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            disabled={!canEdit || saveMutation.isPending}
            placeholder={activeOrg.contact_email || '尚未设置'}
            className="h-9 text-[12.5px]"
          />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label className="text-[12px]">组织 Logo</Label>
            <InfoHint text="本地选图后自动裁成正方形 256×256 并 JPEG 压缩；建议上传方形图片。" />
          </div>
          <div className="flex items-center gap-3">
            {/* logo 预览 */}
            <div
              className={cn(
                'relative h-16 w-16 shrink-0 rounded-lg overflow-hidden flex items-center justify-center',
                logoUrl
                  ? 'ring-1 ring-foreground/10'
                  : 'bg-gradient-to-br from-accent to-accent/70 text-background',
              )}
            >
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <Building2 size={22} />
              )}
              {processingLogo && (
                <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
                  <Loader2 size={14} className="animate-spin text-foreground/55" />
                </div>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePickLogo}
                disabled={!canEdit || processingLogo || saveMutation.isPending}
                className="h-8"
              >
                <Upload size={12} className="mr-1.5" />
                {logoUrl ? '换一张' : '上传图片'}
              </Button>
              {logoUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearLogo}
                  disabled={!canEdit || processingLogo}
                  className="h-7 text-[11.5px] text-foreground/55 hover:text-destructive"
                >
                  <Trash2 size={11} className="mr-1" />
                  清除
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleLogoFileChange}
              className="hidden"
            />
          </div>
        </div>
      </div>

      {canEdit && (
        <div className="flex justify-end">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending
              ? <Loader2 size={12} className="animate-spin mr-1.5" />
              : <Save size={12} className="mr-1.5" />}
            保存
          </Button>
        </div>
      )}
    </div>
  )
}
