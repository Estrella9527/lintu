const isMac = navigator.platform.includes('Mac')

export function TopBar() {
  return (
    <div
      className="titlebar-drag-region flex items-center h-[42px] shrink-0"
      style={{ paddingLeft: isMac ? 84 : 16, paddingRight: 16 }}
    />
  )
}
