import type { ReactNode } from 'react'

interface ConfigCardProps {
  children: ReactNode
}

export function ConfigCard({ children }: ConfigCardProps) {
  return (
    <div className="rounded-lg border border-foreground/5 p-4 space-y-4">
      {children}
    </div>
  )
}
