import { useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Save, Trash2, Upload, User as UserIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, api } from '@/lib/api'
import { currentUserAtom } from '@/atoms/auth'
import { InfoHint } from '@/components/shared/InfoHint'
import { fileToAvatarDataUrl } from '@/lib/imageUtil'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onClose: () => void
}

/** 个人设置 — 改昵称 / 头像 URL。手机号是登录身份，需要专门的换绑流程。 */
export function ProfileDialog({ open, onClose }: Props) {
  const [user, setUser] = useAtom(currentUserAtom)
  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [processing, setProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 每次打开 dialog 都重置为最新值
  useEffect(() => {
    if (!open) return
    setDisplayName(user?.display_name ?? '')
    setAvatarUrl(user?.avatar_url ?? '')
  }, [open, user?.display_name, user?.avatar_url])

  const handlePickFile = () => fileInputRef.current?.click()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''  // 让重新选同一张图也能触发
    if (!f) return
    setProcessing(true)
    try {
      const dataUrl = await fileToAvatarDataUrl(f, 256)
      setAvatarUrl(dataUrl)
    } catch (err) {
      toast.error((err as Error).message || '图片处理失败')
    } finally {
      setProcessing(false)
    }
  }

  const handleClearAvatar = () => setAvatarUrl('')

  const initial = (displayName || user?.phone || '?').slice(0, 1).toUpperCase()

  const saveMutation = useMutation({
    mutationFn: () => api.auth.updateMe({
      display_name: displayName,
      avatar_url: avatarUrl,
    }),
    onSuccess: (updated) => {
      setUser(updated)
      toast.success('已保存')
      onClose()
    },
    onError: (e: Error) => {
      const msg = ((e as ApiError).body as any)?.detail?.message || e.message
      toast.error(`保存失败：${msg}`)
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-[14px]">个人设置</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 头像上传 */}
          <div className="space-y-1.5">
            <Label className="text-[12px] inline-flex items-center gap-1">
              头像
              <InfoHint text="本地选图后自动裁成正方形 256×256 并 JPEG 压缩；不会泄漏原图分辨率。" />
            </Label>
            <div className="flex items-center gap-3">
              {/* 头像预览 */}
              <div
                className={cn(
                  'relative h-16 w-16 shrink-0 rounded-full overflow-hidden flex items-center justify-center',
                  avatarUrl
                    ? 'ring-1 ring-foreground/10'
                    : 'bg-foreground/5 text-foreground/55 text-[20px] font-medium',
                )}
              >
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  initial
                )}
                {processing && (
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
                  onClick={handlePickFile}
                  disabled={processing || saveMutation.isPending}
                  className="h-8"
                >
                  <Upload size={12} className="mr-1.5" />
                  {avatarUrl ? '换一张' : '上传图片'}
                </Button>
                {avatarUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleClearAvatar}
                    disabled={processing}
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
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">昵称</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="留空则显示手机号"
              maxLength={32}
              className="h-9 text-[12.5px]"
            />
          </div>

          {/* 只读：手机号 */}
          <div className="space-y-1.5">
            <Label className="text-[12px] text-foreground/55 inline-flex items-center gap-1">
              手机号
              <InfoHint text="手机号是登录身份，不能直接修改。换绑流程稍后开放。" />
            </Label>
            <Input
              value={user?.phone || ''}
              readOnly
              disabled
              className="h-9 text-[12.5px] tabular-nums bg-foreground/[0.02]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            取消
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending
              ? <Loader2 size={12} className="animate-spin mr-1.5" />
              : <Save size={12} className="mr-1.5" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
