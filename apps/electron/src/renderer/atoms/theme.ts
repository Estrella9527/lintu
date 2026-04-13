import { atom } from 'jotai'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'lintu-theme'

function getInitialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {}
  return 'system'
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {}
}

// Apply on load
const initial = getInitialTheme()
applyTheme(initial)

export const themeAtom = atom(
  initial,
  (_get, set, newMode: ThemeMode) => {
    set(themeAtom, newMode)
    applyTheme(newMode)
  },
)
