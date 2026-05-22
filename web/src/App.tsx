import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Layout } from '@/components/layout'
import { A2HSInstructionsSheet } from '@/components/pwa/a2hs-sheet'
import { Overview } from '@/routes/overview'
import { Focus } from '@/routes/focus'
import { Board } from '@/routes/board'
import { Files } from '@/routes/files'
import { Scheduler } from '@/routes/scheduler'
import { Settings } from '@/routes/settings'

// DEV-only verification pages (M11 /dev/tiles, M13 /dev/term/:name, …). Lazy so
// neither the route component nor its mock data lands in the production bundle.
const DevTiles = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-tiles'))
  : null
const DevTerm = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-term'))
  : null
// M14 desktop focus-mode review page (split + strip + dock + peek-popover).
const DevFocus = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-focus'))
  : null

// TanStack Query is the source of truth for server data; SSE invalidates it
// (no polling — see use-sse.ts). Defaults per §M10 / §4.1.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
})

export default function App() {
  return (
    // basename uses BASE_URL so the Capacitor `capacitor://localhost` origin
    // works unchanged (§4.10).
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            {/* M23b: "Add to Home Screen" coaching sheet — self-gates to the
                first iOS-Safari (non-standalone) load, then remembers dismiss. */}
            <A2HSInstructionsSheet />
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Overview />} />
                <Route path="/focus/:name" element={<Focus />} />
                <Route path="/board" element={<Board />} />
                <Route path="/files/:name?" element={<Files />} />
                <Route path="/scheduler" element={<Scheduler />} />
                <Route path="/settings" element={<Settings />} />
              </Route>
              {DevTiles && (
                <Route
                  path="/dev/tiles"
                  element={
                    <Suspense fallback={null}>
                      <DevTiles />
                    </Suspense>
                  }
                />
              )}
              {DevTerm && (
                <Route
                  path="/dev/term/:name"
                  element={
                    <Suspense fallback={null}>
                      <DevTerm />
                    </Suspense>
                  }
                />
              )}
              {DevFocus && (
                <Route
                  path="/dev/focus/:name?"
                  element={
                    <Suspense fallback={null}>
                      <DevFocus />
                    </Suspense>
                  }
                />
              )}
            </Routes>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
