import { Toaster as Sonner, type ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  const isDark = document.documentElement.classList.contains('dark')
  return (
    <Sonner
      theme={isDark ? 'dark' : 'light'}
      position="top-right"
      closeButton
      className="toaster group"
      toastOptions={{
        className: '!rounded-xl group',
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
