import { atom } from 'jotai'

const STORAGE_KEY = 'lintu-active-project'

function getInitial(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null
  } catch {
    return null
  }
}

export const activeProjectIdAtom = atom(
  getInitial(),
  (_get, set, id: string | null) => {
    set(activeProjectIdAtom, id)
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {}
  },
)
