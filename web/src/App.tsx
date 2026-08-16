import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToastProvider } from '@/components/ui/toast'
import { Layout } from '@/components/layout'
import { A2HSInstructionsSheet } from '@/components/pwa/a2hs-sheet'
import { OnboardingHost } from '@/components/onboarding/onboarding-host'
import { useRendererPrefsSync } from '@/hooks/use-renderer-prefs-sync'
import { ConnectionOverlay } from '@/components/connection/connection-overlay'
import { Overview } from '@/routes/overview'
import { Focus, FocusEntry } from '@/routes/focus'
import { Board } from '@/routes/board'
import { Files } from '@/routes/files'
// Settings is entry-lazy: it is a cold administrative surface, and its eager
// import tipped the hero-path bundle over the 200 KB gz budget (#67 red).
// (B1 folded the Scheduler route into Settings, so no Scheduler import here.)
const Settings = lazy(() =>
  import('@/routes/settings').then((m) => ({ default: m.Settings })),
)

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
// Mobile focus-mode review page (floating KeyBar / dock / accessory strip —
// mobile-focus-keybar spec). Renders the real <MobileFocus> regardless of
// viewport width so it's screenshot-able from a wide dev browser window.
const DevFocusMobile = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-focus-mobile'))
  : null
// TEAM CARD / teammate-chip / density-toggle verification harness.
const DevTeams = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-teams'))
  : null
// Session-mark bench (fase B0): the whole cast at 18/28/40 in both themes, all
// six states, the 63-token matrix and a live blink/breathe strip.
const DevMarks = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-marks'))
  : null
// Chat-surface primitive bench (fase B0): the approved board rebuilt out of the
// shipped primitives, plus every variant it has no room for, in both themes.
const DevChatUi = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-chat-ui'))
  : null
// Shell bench (fase B1): the painted substrate's three columns, the chrome
// floors and <ShellOverlay> in both variants at the real container-query size —
// the page every B1 VR shot comes from. URL-driven so a rig can request a state.
const DevShell = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-shell'))
  : null
// Chat RENDERER bench (fase A3): the real conversation component, fed the wire
// shapes the server sends, in every state the surface can be in — the page the
// A3 screenshots are taken from.
const DevChatLive = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-chat-live'))
  : null
// The toggle-thrash bench (fase A5 T6): the REAL RendererShell + LiveTerminal,
// toggled 100× against a firehosing `shell` pty by
// `tests/e2e/smoke/chat-toggle-thrash.spec.ts`. Not a product surface.
const DevRendererThrash = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-renderer-thrash'))
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

/** The renderer-preference sync, as a null component — a hook needs a mount
 *  point and `App` itself sits OUTSIDE `QueryClientProvider`. */
function RendererPrefsSync() {
  useRendererPrefsSync()
  return null
}

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
            {/* Fase A5 — cross-device sync for the renderer preference. Renders
                nothing; it mirrors the UI store to /api/prefs/session_renderer
                and back, so a pin made on the phone lands on the desktop within
                one SSE tick. Mounted here (inside QueryClientProvider, outside
                the routes) so exactly one instance exists per app. */}
            <RendererPrefsSync />
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
                {/* Scheduler moved into Settings → Schedules (B1 T8: a route
                    whose 5-column table did not earn a primary-nav slot).
                    Redirect old bookmarks / deep links to the Settings anchor
                    so no link breaks — the exact pattern /hosts uses below. */}
                <Route
                  path="/scheduler"
                  element={<Navigate to="/settings#schedules" replace />}
                />
                {/* Hosts moved into Settings → Remote hosts. Redirect old
                    bookmarks / deep links to the Settings anchor so no link
                    breaks. The fragment lands on the section header. */}
                <Route
                  path="/hosts"
                  element={<Navigate to="/settings#hosts" replace />}
                />
                <Route
                  path="/settings"
                  element={
                    <Suspense fallback={null}>
                      <Settings />
                    </Suspense>
                  }
                />
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
              {DevRendererThrash && (
                <Route
                  path="/dev/renderer-thrash/:name"
                  element={
                    <Suspense fallback={null}>
                      <DevRendererThrash />
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
              {DevFocusMobile && (
                <Route
                  path="/dev/focus-mobile/:name?"
                  element={
                    <Suspense fallback={null}>
                      <DevFocusMobile />
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
              {DevMarks && (
                <Route
                  path="/dev/marks"
                  element={
                    <Suspense fallback={null}>
                      <DevMarks />
                    </Suspense>
                  }
                />
              )}
              {DevChatUi && (
                <Route
                  path="/dev/chat-ui"
                  element={
                    <Suspense fallback={null}>
                      <DevChatUi />
                    </Suspense>
                  }
                />
              )}
              {DevShell && (
                <Route
                  path="/dev/shell"
                  element={
                    <Suspense fallback={null}>
                      <DevShell />
                    </Suspense>
                  }
                />
              )}
              {DevChatLive && (
                <Route
                  path="/dev/chat-live"
                  element={
                    <Suspense fallback={null}>
                      <DevChatLive />
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
