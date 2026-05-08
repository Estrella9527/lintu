import { useState } from 'react'
import { useAtom } from 'jotai'
import { LogOut, Monitor, UserCog } from 'lucide-react'
import { toast } from 'sonner'

import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { authStateAtom, currentUserAtom } from '@/atoms/auth'
import { api, clearAuthToken } from '@/lib/api'
import { cn } from '@/lib/utils'
import { SessionsDialog } from './SessionsDialog'
import { ProfileDialog } from './ProfileDialog'

/**
 * 左下角用户徽章 — 显示头像 / 昵称 / root 标识，点击弹 popover 含退出按钮。
 *
 * 在侧栏折叠时只显示头像；展开时显示头像 + 昵称。
 */
interface Props {
  collapsed: boolean
}

export function UserBadge({ collapsed }: Props) {
  const [user] = useAtom(currentUserAtom)
  const [, setAuthState] = useAtom(authStateAtom)
  const [open, setOpen] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  if (!user) return null

  const initial = (user.display_name || user.phone || '?').slice(0, 1).toUpperCase()

  const handleLogout = async () => {
    setOpen(false)
    try { await api.auth.logout() } catch { /* 服务端登出失败不阻塞前端 */ }
    await clearAuthToken()
    setAuthState('guest')
    toast('已退出登录')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]',
            collapsed ? 'w-9 mx-auto justify-center' : 'w-full',
          )}
          title={user.display_name || user.phone || ''}
        >
          <div
            className={cn(
              'shrink-0 flex items-center justify-center rounded-full text-[11px] font-medium',
              user.is_root
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                : 'bg-accent/15 text-accent',
              collapsed ? 'h-7 w-7' : 'h-7 w-7',
            )}
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="h-full w-full rounded-full object-cover" />
            ) : (
              initial
            )}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-foreground/85 truncate">
                {user.display_name || user.phone || '未命名'}
                {user.is_root && (
                  <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 align-middle">
                    超级管理员
                  </span>
                )}
              </div>
              <div className="text-[10px] text-foreground/45 truncate">
                {user.projects.length > 0 ? `${user.projects.length} 个项目` : '未加入项目'}
              </div>
            </div>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-56 p-2">
        <div className="px-2 py-1.5 border-b border-foreground/5 mb-2">
          <div className="text-[12.5px] font-medium text-foreground/85 truncate">
            {user.display_name || '未命名'}
          </div>
          <div className="text-[10.5px] text-foreground/45 truncate">
            {user.phone || ''}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setOpen(false); setShowProfile(true) }}
          className="w-full justify-start text-foreground/75 hover:text-foreground"
        >
          <UserCog size={12} className="mr-1.5" />
          个人设置
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setOpen(false); setShowSessions(true) }}
          className="w-full justify-start text-foreground/75 hover:text-foreground"
        >
          <Monitor size={12} className="mr-1.5" />
          我的登录设备
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <LogOut size={12} className="mr-1.5" />
          退出登录
        </Button>
      </PopoverContent>
      <SessionsDialog open={showSessions} onClose={() => setShowSessions(false)} />
      <ProfileDialog open={showProfile} onClose={() => setShowProfile(false)} />
    </Popover>
  )
}
