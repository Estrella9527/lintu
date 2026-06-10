import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { jotaiStore } from '@/lib/jotaiStore'
import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStore}>
        <App />
        <Toaster />
      </JotaiProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)

// Remove loader
const loader = document.getElementById('loader')
if (loader) {
  loader.style.opacity = '0'
  setTimeout(() => loader.remove(), 200)
}
