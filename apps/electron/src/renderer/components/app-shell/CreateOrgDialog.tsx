import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, api } from '@/lib/api'
import { activeOrgIdAtom, myOrgsAtom } from '@/atoms/auth'

interface Props {
  open: boolean
  onClose: () => void
}

const SLUG_OK = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const PHONE_OK = /^1[3-9]\d{9}$/

export function CreateOrgDialog({ open, onClose }: Props) {
  const [, setMyOrgs] = useAtom(myOrgsAtom)
  const [, setActiveId] = useAtom(activeOrgIdAtom)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [ownerPhone, setOwnerPhone] = useState('')
  const [plan, setPlan] = useState('free')

  const reset = () => {
    setName(''); setSlug(''); setContactEmail(''); setOwnerPhone(''); setPlan('free')
  }

  const createMutation = useMutation({
    mutationFn: () => api.orgs.create({
      name: name.trim(),
      slug: slug.trim(),
      contact_email: contactEmail.trim() || undefined,
      initial_owner_phone: ownerPhone.trim(),
      plan,
    }),
    onSuccess: async (org) => {
      // 重拉组织列表 + 切到新建的组织
      try {
        const all = await api.orgs.list()
        setMyOrgs(all)
        setActiveId(org.id)
      } catch { /* ignore */ }
      toast.success(`组织「${org.name}」已创建`)
      reset()
      onClose()
    },
    onError: (e: Error) => {
      const detail = (e as ApiError).body
      const msg = (detail as any)?.detail?.message || e.message
      toast.error(`创建失败：${msg}`)
    },
  })

  const nameValid = name.trim().length >= 1
  const slugValid = SLUG_OK.test(slug.trim())
  const phoneValid = PHONE_OK.test(ownerPhone.trim())
  const allValid = nameValid && slugValid && phoneValid

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">创建新组织</DialogTitle>
          <DialogDescription className="text-[11.5px] text-foreground/55">
            一个组织 = 一群人 + 一组项目 + 一份云端数据。仅平台超管可创建。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[12px]">组织名称 *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：示例景区A旅游有限公司"
              className="h-9 text-[12.5px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">Slug（URL 短名）*</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="如：longjing"
              className="h-9 text-[12.5px] font-mono tabular-nums"
            />
            <p className="text-[10.5px] text-foreground/45">
              2-32 字符，仅小写字母 / 数字 / 连字符；头尾非连字符。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">联系邮箱（选填）</Label>
            <Input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="contact@longjing.com"
              className="h-9 text-[12.5px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">初始 Owner 手机号 *</Label>
            <div className="flex gap-2">
              <span className="inline-flex items-center px-3 h-9 rounded-md border border-foreground/15 bg-foreground/[0.02] text-[12px] text-foreground/55">
                +86
              </span>
              <Input
                type="tel"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                placeholder="138 1234 5678"
                className="flex-1 h-9 text-[12.5px] tabular-nums"
              />
            </div>
            <p className="text-[10.5px] text-foreground/45">
              该手机号下次登录时自动成为该组织的 owner（也可以是你自己）。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[12px]">套餐</Label>
            <div className="flex gap-2">
              {(['free', 'pro', 'enterprise'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlan(p)}
                  className={
                    'flex-1 h-9 rounded-md border text-[12px] transition-colors ' +
                    (plan === p
                      ? 'border-accent bg-accent/10 text-accent font-medium'
                      : 'border-foreground/10 text-foreground/65 hover:border-foreground/20')
                  }
                >
                  {p === 'free' ? 'Free · 10GB' : p === 'pro' ? 'Pro · 100GB' : 'Enterprise · 1TB'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={createMutation.isPending}>
            取消
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!allValid || createMutation.isPending}
          >
            {createMutation.isPending && <Loader2 size={12} className="animate-spin mr-1.5" />}
            创建组织
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
