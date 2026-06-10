import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToastProvider } from '@/components/ui/toast'
import { Layout } from '@/components/layout'
import { A2HSInstructionsSheet } from '@/components/pwa/a2hs-sheet'
import { OnboardingHost } from '@/components/onboarding/onboarding-host'
import { ConnectionOverlay } from '@/components/connection/connection-overlay'
import { Overview } from '@/routes/overview'
import { Focus, FocusEntry } from '@/routes/focus'
import { Board } from '@/routes/board'
import { Files } from '@/routes/files'
import { Scheduler } from '@/routes/scheduler'
import { Settings } from '@/routes/settings'

// DEV-only verification pages (/dev/tiles, /dev/term/:name, …). Lazy so
// neither the route component nor its mock data lands in the production bundle.
const DevTiles = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-tiles'))
  : null
const DevTerm = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-term'))
  : null
// Desktop focus-mode review page (split + strip + dock + peek-popover).
const DevFocus = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-focus'))
  : null
// TEAM CARD / teammate-chip / density-toggle verification harness.
const DevTeams = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-teams'))
  : null

// TanStack Query is the source of truth for server data; SSE invalidates it
// (no polling — see use-sse.ts).
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
    // works unchanged.
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            {/* App-root toast scope. Mounted here so any route — overview
                archive Undo, board, scheduler — can fire toasts from one
                provider. Routes that previously self-wrapped (scheduler) no
                longer need their own. */}
            <ToastProvider>
            {/* "Add to Home Screen" coaching sheet — self-gates to the
                first iOS-Safari (non-standalone) load, then remembers dismiss. */}
            <A2HSInstructionsSheet />
            {/* First-60-seconds unboxing — welcome banner + 4-step tour
                (step 4 = Agent Teams explainer) for migrated v2 users;
                self-gates to the first launch only. */}
            <OnboardingHost />
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Overview />} />
                {/* `/focus` (no `:name`) — the desktop SideNav Focus item
                    points here. Resolves to the last-active session, falling
                    back to the first live session, then overview. */}
                <Route path="/focus" element={<FocusEntry />} />
                <Route path="/focus/:name" element={<Focus />} />
                <Route path="/board" element={<Board />} />
                <Route path="/files/:name?" element={<Files />} />
                <Route path="/scheduler" element={<Scheduler />} />
                {/* Hosts moved into Settings → Remote hosts. Redirect old
                    bookmarks / deep links to the Settings anchor so no link
                    breaks. The fragment lands on the section header. */}
                <Route
                  path="/hosts"
                  element={<Navigate to="/settings#hosts" replace />}
                />
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
              {DevTeams && (
                <Route
                  path="/dev/teams"
                  element={
                    <Suspense fallback={null}>
                      <DevTeams />
                    </Suspense>
                  }
                />
              )}
            </Routes>
            </ToastProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
      {/* App-root branded overlay for hard outages — offline / server
       *  unreachable / auth-invalid. Mounted OUTSIDE the providers so it can
       *  render even if a provider crashed (e.g. QueryClient fetching during a
       *  network drop). Renders nothing while the connection is healthy. */}
      <ConnectionOverlay />
    </BrowserRouter>
  )
}
