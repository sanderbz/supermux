import { lazy, Suspense } from 'react'
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ToastProvider } from '@/components/ui/toast'
import { Layout } from '@/components/layout'
import { A2HSInstructionsSheet } from '@/components/pwa/a2hs-sheet'
import { PushBridge } from '@/components/pwa/push-bridge'
import { SWUpdatePrompt } from '@/components/pwa/sw-update-prompt'
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog'
import { OnboardingHost } from '@/components/onboarding/onboarding-host'
import { ViewerBoundary } from '@/components/auth/viewer-boundary'
import { useIsOwnerPlane } from '@/stores/viewer-store'
import { useRendererPrefsSync } from '@/hooks/use-renderer-prefs-sync'
import { ConnectionOverlay } from '@/components/connection/connection-overlay'
import { MorphCommitProbe } from '@/components/view-transitions/morph'
import { Overview } from '@/routes/overview'
import { Focus, FocusEntry } from '@/routes/focus'
// Files is entry-lazy for the same reason Settings is, and for a reason of its
// own: the cold hero path is the OVERVIEW, and the entry chunk should not carry
// a file browser to render a roster. Files v1 (the Bot Company Drive) roughly
// doubled the route's weight — Spaces grid, four `ResponsiveSheet` surfaces, a
// dir picker, the bulk bar — and eagerly imported that put ~7.6 KB gz of it on
// first paint for every user who never opened Files at all. Lazy is where it
// belongs, alongside Settings, Store and TeamDetail.
const Files = lazy(() =>
  import('@/routes/files').then((m) => ({ default: m.Files })),
)
// Settings is entry-lazy: it is a cold administrative surface, and its eager
// import tipped the hero-path bundle over the 200 KB gz budget (#67 red).
// (B1 folded the Scheduler route into Settings, so no Scheduler import here.)
const Settings = lazy(() =>
  import('@/routes/settings').then((m) => ({ default: m.Settings })),
)
// The shared-browser WORKSPACE (/browser) — lazy for the same reason the store
// is, plus one of its own: it pulls in the takeover canvas + socket, which no
// other route needs.
const BrowserWorkspaceRoute = lazy(() =>
  import('@/routes/browser').then((m) => ({ default: m.BrowserRoute })),
)
// The connector store — lazy like Settings: a headline surface, but not on the
// cold hero path, and its catalog/card tree should not weigh the entry bundle.
const Store = lazy(() =>
  import('@/routes/store').then((m) => ({ default: m.Store })),
)
// Workflows — the list, the composer and the run history. Lazy like the store:
// a headline surface, but not on the cold hero path, and the composer's step
// tree / cadence grammar should not weigh the entry bundle.
const Workflows = lazy(() =>
  import('@/routes/workflows').then((m) => ({ default: m.Workflows })),
)
// The composer is its OWN chunk: the step tree, the cadence grammar and the
// upload engine are only paid for by somebody who is actually composing.
const WorkflowEdit = lazy(() =>
  import('@/routes/workflow-edit').then((m) => ({ default: m.WorkflowEdit })),
)
const WorkflowDetail = lazy(() =>
  import('@/routes/workflow-detail').then((m) => ({ default: m.WorkflowDetail })),
)
// The phone team-detail surface (Phase 6a). Lazy so the 160 KB entry gate never
// carries ChatPanel/TeamPanel/MemberPane for a route the roster only reaches on a
// phone tap (and which redirects to /focus when bot mode is off).
const TeamDetail = lazy(() =>
  import('@/routes/team-detail').then((m) => ({ default: m.TeamDetail })),
)
const CompanyChat = lazy(() =>
  import('@/routes/company-chat').then((m) => ({ default: m.CompanyChat })),
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
// Roster bench (fase B2): one row at three densities × six mark states × three
// attention tiers, the tile at four overview tiers, both themes on one page.
const DevRoster = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-roster'))
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
// Company GROUP CHAT bench (spec §7): the `<ChatChannel>` hero at 390/402px with
// an offline cast — every message kind at once, no socket behind it.
const DevGroupChat = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-groupchat'))
  : null
// Chat RENDERER bench (fase A3): the real conversation component, fed the wire
// shapes the server sends, in every state the surface can be in — the page the
// A3 screenshots are taken from.
const DevChatLive = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-chat-live'))
  : null
// Composer attachment bench (feat/grok-mode): a REAL wired composer
// (`useComposer` + REST input + `useStagedAttachments`) so an offline rig can
// drive pick→upload→chip→send and assert the `/send` payload carries the path.
const DevComposerAttach = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-composer-attach'))
  : null
// The picker bench (fase B3 T2.8): both anchors × nine kinds × empty/loading/
// overflow, in both themes, with no server behind it.
const DevPickers = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-pickers'))
  : null
// The workflows bench (T5.10): list · composer · run timeline · connector
// picker, in both themes, at phone and desktop widths, with no server behind
// any of it. See the file header for the query flags.
const DevWorkflows = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-workflows'))
  : null
// The Files v1 bench: the Spaces grid, the destination sheet and the
// multi-select bottom bar, hand-fed and seeded, for the 390px review pass.
const DevFiles = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-files'))
  : null
// The toggle-thrash bench (fase A5 T6): the REAL RendererShell + LiveTerminal,
// toggled 100× against a firehosing `shell` pty by
// `tests/e2e/smoke/chat-toggle-thrash.spec.ts`. Not a product surface.
const DevRendererThrash = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-renderer-thrash'))
  : null
// Text-selection stand-down bench: the REAL chat follow hook + a REAL xterm,
// used by the offline rig to prove a held selection survives the peek re-render /
// height reflow. Dev-only, absent from the production bundle.
const DevSelectionProbe = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-selection-probe'))
  : null
// Shared-browser TAKEOVER bench (connector phase 2): the canvas panel fed
// either a live `/ws/browser/{name}/takeover` socket (`?session=NAME`) or an
// authentic captured frame with no server at all (`?mock=1`). Phase 3 moves
// this surface onto the connector card; it is dev-only until then, so the base
// app is completely unaffected.
const DevBrowserTakeover = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-browser-takeover'))
  : null
// Shared-browser WORKSPACE bench — the tab rail + the per-tab grant sheet +
// the viewport, on fixture tabs, offline. The page the /browser shots come from.
const DevBrowserWorkspace = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-browser-workspace'))
  : null
// Smart sign-in bench — every state of the FIELD-AWARE sign-in sheet (no-form /
// detected / ambiguous-mapper / otp / generate-only / frame / blind) on a
// hand-built LoginScan, offline. The page the sign-in shots come from.
const DevSignIn = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-sign-in'))
  : null
// Connector-store bench — the grid + bot-scoped sheet + inline connect-card, in
// both themes and the [data-grok] skin, offline. The page the store shots come
// from.
const DevStore = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-store'))
  : null
// Task-first create-a-bot bench (Plan 1 / Workflow A): the real "Hire a new bot"
// sheet open with `botVoiced`, both steps, offline. The page the create-sheet
// shots come from.
const DevNewSession = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-new-session'))
  : null
// iOS keyboard DIAGNOSTIC readout (fix/ios-zoom-composer). A self-contained,
// live-updating page that reads the real iOS-WebKit viewport/keyboard numbers
// off the device so the black-bar fix can be device-verified. Lazy + DEV-gated
// like every other bench — absent from the production bundle, base app
// byte-identical.
const DevKbdProbe = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-kbd-probe'))
  : null
// Companies onboarding wizard bench (feat/companies-grok). Exercises the full
// resumable stepper against the in-memory mock (`?mock`) with no live Cloudflare
// token / Google app / server. Lazy + DEV-gated — absent from production.
const DevInvite = import.meta.env.DEV
  ? lazy(() => import('@/routes/dev-invite'))
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

/** Guard for a route that belongs to the OWNER plane. A member is redirected to
 *  their own roster (`/`) rather than shown a page whose every panel the server
 *  refuses. `replace` so the back button does not bounce them into it again. */
function OwnerPlaneRoute({ children }: { children: React.ReactNode }) {
  const ownerPlane = useIsOwnerPlane()
  if (!ownerPlane) return <Navigate to="/" replace />
  return <>{children}</>
}

/** The renderer-preference sync, as a null component — a hook needs a mount
 *  point and `App` itself sits OUTSIDE `QueryClientProvider`. */
function RendererPrefsSync() {
  useRendererPrefsSync()
  return null
}

/**
 * PHASE 0.2 — dev-bench skin wrapper. `?grok=1` on any `/dev/*` route stamps
 * `data-grok` + `data-grok-root`, the two attributes `<Layout>` stamps on the
 * real shell, so a bench renders under the REAL skin (`styles/grok-mode.css`,
 * every rule scoped `[data-grok]`) instead of needing the harness to inject
 * them. `data-grok-root` is the ground marker the structural rules key off
 * (`[data-grok][data-grok-root]`), so the wrapper must be a real, full-size box
 * — which is exactly why it is NOT rendered without the param: no param, no
 * element, no layout change for any existing bench.
 *
 * DEV-only in practice: every child route here is `import.meta.env.DEV &&`, so
 * in production this parent has no matching child and never renders.
 */
function DevSkin() {
  const { search } = useLocation()
  const grok = new URLSearchParams(search).get('grok') === '1'
  if (!grok) return <Outlet />
  return (
    <div data-grok="" data-grok-root="" className="min-h-dvh w-full bg-background">
      <Outlet />
    </div>
  )
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
            {/* B5/T9.3 — the consequential-confirm host. Mounted once here so a
                `useConfirm()` anywhere in the tree resolves against ONE dialog
                rather than each surface hand-rolling an open flag and a pending
                action. This is what let the last four `window.confirm` calls
                go: an OS confirm can only render a string, which is why the
                consequence enumeration was impossible before. */}
            <ConfirmDialogProvider>
            {/* THE VIEWER IDENTITY GATE (fix/invite-viewer-identity). Everything
                below renders only once we know WHO is looking: an anonymous
                visitor on a company host gets the branded login screen instead of
                the app (and, critically, instead of the Bot-Mode onboarding
                intro, which used to be the first thing they saw); an invited
                colleague gets the app locked to their own company plus a
                one-time name sheet. The OWNER path is unchanged and synchronous —
                a shell carrying the spliced admin bearer resolves to `owner` in
                the store's initial state, so children paint on the first frame
                exactly as before. */}
            <ViewerBoundary>
            {/* "Add to Home Screen" coaching sheet — self-gates to the
                first iOS-Safari (non-standalone) load, then remembers dismiss. */}
            <A2HSInstructionsSheet />
            {/* B5/T3 — the in-app half of the notification pipeline. Renders
                nothing; it listens for the payloads the service worker
                forwards, keeps the home-screen badge honest, and tells the SW
                which lock-screen card has gone stale. Mounted here, inside the
                providers, because it reads the sessions snapshot. */}
            <PushBridge />
            {/* "Reload to update" — surfaces a one-tap adoption of a freshly
                deployed app shell when a new service worker is waiting and the
                app was not idle enough to adopt it silently. Renders nothing
                otherwise. Mounted here so a deploy reaches the client from any
                route. See lib/sw-update.ts for the idle-guarded state machine. */}
            <SWUpdatePrompt />
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
            {/* Renders nothing; tells an in-flight route morph the moment React
                has COMMITTED the new route, so `startViewTransition` captures
                the destination instead of a second copy of the origin. Must be
                inside the router and mounted exactly once — see
                `components/view-transitions/morph.tsx`. */}
            <MorphCommitProbe />
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Overview />} />
                {/* `/agent/:name` — the ADDRESS of a bot's home thread, and the
                    canonical "open this agent" link everywhere in the app (see
                    `lib/agent-href.ts`). It renders the SAME <Overview /> element
                    as `/` on purpose: same component type at the same position in
                    the tree, so React reconciles instead of remounting, and the
                    roster keeps the selection it just made from the name while it
                    replaces the URL with `/`. The shell treats the path as home
                    too (layout.tsx). `/focus/:name` below stays the terminal. */}
                <Route path="/agent/:name" element={<Overview />} />
                {/* `/focus` (no `:name`) — the desktop SideNav Focus item
                    points here. Resolves to the last-active session, falling
                    back to the first live session, then overview. */}
                <Route path="/focus" element={<FocusEntry />} />
                <Route path="/focus/:name" element={<Focus />} />
                {/* The Board PAGE is gone (fase B2 T11) — issues live in session
                    detail and on the team card now. The API, its public iCal
                    route, the `/api/hook/board/*` edge and the `supermux-task`
                    skill are all UNCHANGED. Redirect rather than 404 so a
                    bookmark lands somewhere honest — the same pattern /scheduler
                    and /hosts use. */}
                <Route path="/board" element={<Navigate to="/" replace />} />
                <Route
                  path="/files/:name?"
                  element={
                    <Suspense fallback={null}>
                      <Files />
                    </Suspense>
                  }
                />
                {/* Schedules became Workflows. Both old doorways — the
                    standalone `/scheduler` route and the Settings anchor B1
                    folded it into — land on the new list, so no bookmark and no
                    deep link breaks. A redirect rather than a 404 is the same
                    courtesy /hosts and /board already get. The Settings
                    ANCHOR (`/settings#schedules`) is a hash, which no path
                    route can match; the section it scrolls to is deleted with
                    the rest of the scheduler UI in 4B, and the command palette
                    entry that used to point there now points here. */}
                <Route path="/scheduler" element={<Navigate to="/workflows" replace />} />
                <Route
                  path="/workflows"
                  element={
                    <Suspense fallback={null}>
                      <Workflows />
                    </Suspense>
                  }
                />
                {/* `new` is registered BEFORE `:id` so the literal wins — the
                    same static-before-capture ordering the server router keeps
                    for `/api/workflows/preview`. */}
                <Route
                  path="/workflows/new"
                  element={
                    <Suspense fallback={null}>
                      <WorkflowEdit />
                    </Suspense>
                  }
                />
                <Route
                  path="/workflows/:id/edit"
                  element={
                    <Suspense fallback={null}>
                      <WorkflowEdit />
                    </Suspense>
                  }
                />
                <Route
                  path="/workflows/:id"
                  element={
                    <Suspense fallback={null}>
                      <WorkflowDetail />
                    </Suspense>
                  }
                />
                {/* Hosts moved into Settings → Remote hosts. Redirect old
                    bookmarks / deep links to the Settings anchor so no link
                    breaks. The fragment lands on the section header. */}
                <Route
                  path="/hosts"
                  element={<Navigate to="/settings#hosts" replace />}
                />
                {/* Settings is the OWNER PLANE's front door — Updates, Remote
                    hosts, External access, the company lifecycle. It is dropped
                    from nav and from ⌘K for an invited colleague; this closes
                    the last way in (a typed URL / an old bookmark) by landing
                    them on their own roster instead of a page of surfaces the
                    server would refuse one by one. */}
                <Route
                  path="/settings"
                  element={
                    <OwnerPlaneRoute>
                      <Suspense fallback={null}>
                        <Settings />
                      </Suspense>
                    </OwnerPlaneRoute>
                  }
                />
                <Route
                  path="/store/:id?"
                  element={
                    <Suspense fallback={null}>
                      <Store />
                    </Suspense>
                  }
                />
                <Route
                  path="/browser"
                  element={
                    <Suspense fallback={null}>
                      <BrowserWorkspaceRoute />
                    </Suspense>
                  }
                />
                {/* Phase 6a — the phone team-detail surface. Two arms (team /
                    team+member); the component redirects to /focus/<lead> when
                    bot mode is off, so the base app never renders it. Inside
                    <Layout> so it inherits the grok skin + providers; Layout
                    treats `/team/*` as a full-bleed route (no top/bottom nav),
                    the same as /focus. */}
                <Route
                  path="/team/:teamName"
                  element={
                    <Suspense fallback={null}>
                      <TeamDetail />
                    </Suspense>
                  }
                />
                <Route
                  path="/team/:teamName/:agentId"
                  element={
                    <Suspense fallback={null}>
                      <TeamDetail />
                    </Suspense>
                  }
                />
                {/* The company GROUP CHAT, full-bleed (spec §7). The overview
                    carries only a compact doorway; this is where the channel is
                    a page. Chromeless like /team — <Layout> gates it below. */}
                <Route
                  path="/company/:companyId/chat"
                  element={
                    <Suspense fallback={null}>
                      <CompanyChat />
                    </Suspense>
                  }
                />
              </Route>
              {/* PHASE 0.2 — the DEV BENCH SKIN GATE (`?grok=1`).
                  The /dev/* benches mount OUTSIDE <Layout>, which is the only
                  place `data-grok` / `data-grok-root` are stamped — so a bench
                  could only ever be reviewed in the BASE skin, and every grok
                  screenshot needed the attribute injected by the capture
                  harness. This pathless parent route stamps the same two
                  attributes when the URL carries `?grok=1`.
                  Without the param it renders a BARE <Outlet/> — zero extra DOM,
                  so every existing bench is byte-identical. */}
              <Route element={import.meta.env.DEV ? <DevSkin /> : <Outlet />}>
              {DevBrowserWorkspace && (
                <Route
                  path="/dev/browser-workspace"
                  element={
                    <Suspense fallback={null}>
                      <DevBrowserWorkspace />
                    </Suspense>
                  }
                />
              )}
              {DevSignIn && (
                <Route
                  path="/dev/sign-in"
                  element={
                    <Suspense fallback={null}>
                      <DevSignIn />
                    </Suspense>
                  }
                />
              )}
              {DevStore && (
                <Route
                  path="/dev/store"
                  element={
                    <Suspense fallback={null}>
                      <DevStore />
                    </Suspense>
                  }
                />
              )}
              {DevNewSession && (
                <Route
                  path="/dev/new-session"
                  element={
                    <Suspense fallback={null}>
                      <DevNewSession />
                    </Suspense>
                  }
                />
              )}
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
              {DevSelectionProbe && (
                <Route
                  path="/dev/selection-probe"
                  element={
                    <Suspense fallback={null}>
                      <DevSelectionProbe />
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
              {DevRoster && (
                <Route
                  path="/dev/roster"
                  element={
                    <Suspense fallback={null}>
                      <DevRoster />
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
              {DevGroupChat && (
                <Route
                  path="/dev/groupchat"
                  element={
                    <Suspense fallback={null}>
                      <DevGroupChat />
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
              {DevComposerAttach && (
                <Route
                  path="/dev/composer-attach"
                  element={
                    <Suspense fallback={null}>
                      <DevComposerAttach />
                    </Suspense>
                  }
                />
              )}
              {DevBrowserTakeover && (
                <Route
                  path="/dev/browser-takeover"
                  element={
                    <Suspense fallback={null}>
                      <DevBrowserTakeover />
                    </Suspense>
                  }
                />
              )}
              {DevPickers && (
                <Route
                  path="/dev/pickers"
                  element={
                    <Suspense fallback={null}>
                      <DevPickers />
                    </Suspense>
                  }
                />
              )}
              {DevWorkflows && (
                <Route
                  path="/dev/workflows"
                  element={
                    <Suspense fallback={null}>
                      <DevWorkflows />
                    </Suspense>
                  }
                />
              )}
              {DevFiles && (
                <Route
                  path="/dev/files"
                  element={
                    <Suspense fallback={null}>
                      <DevFiles />
                    </Suspense>
                  }
                />
              )}
              {DevKbdProbe && (
                <Route
                  path="/dev/kbd-probe"
                  element={
                    <Suspense fallback={null}>
                      <DevKbdProbe />
                    </Suspense>
                  }
                />
              )}
              {DevInvite && (
                <Route
                  path="/dev/invite"
                  element={
                    <Suspense fallback={null}>
                      <DevInvite />
                    </Suspense>
                  }
                />
              )}
              </Route>
            </Routes>
            </ViewerBoundary>
            </ConfirmDialogProvider>
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
