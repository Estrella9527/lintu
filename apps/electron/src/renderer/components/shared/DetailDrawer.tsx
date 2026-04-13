import type { ReactNode } from 'react'
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'

interface DetailDrawerProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}

export function DetailDrawer({ open, onClose, title, children }: DetailDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()} direction="right">
      <DrawerContent
        className="h-full w-[480px] max-w-[90vw] rounded-l-xl rounded-r-none"
        style={{ position: 'fixed', right: 0, top: 0, bottom: 0 }}
      >
        <DrawerHeader className="border-b border-foreground/5 px-6 py-4">
          <DrawerTitle className="text-[15px] font-semibold">{title}</DrawerTitle>
        </DrawerHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
