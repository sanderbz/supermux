import * as React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import {
  FolderClosed,
  LayoutGrid,
  Settings as SettingsIcon,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { isShellSubstrateEnabled } from '@/lib/shell-substrate-flag'
import {
  ShellOverlayProvider,
  useShellOverlayProvider,
} from '@/components/shell/use-shell-overlay'
import {
  MorphNavLink,
  NAV_ACTIVE_VT_NAME,
} from '@/components/view-transitions/morph'
import { Logo } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReconnectBanner } from '@/components/status-banner/reconnect-banner'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { ArchivedSheet } from '@/components/archived/archived-sheet'
import { useArchivedSheet } from '@/stores/archived-sheet-store'
import { useStandaloneMode } from '@/hooks/use-standalone-mode'
import { useSseStatus } from '@/hooks/use-sse'
import { useSseConnectionLink } from '@/hooks/use-connection-link'
import { useUpdateBadge, type UpdateBadgeState } from '@/hooks/use-update-badge'
import {
  RosterMarksProvider,
  useRosterMarksProvider,
} from '@/hooks/use-roster-marks'
import { AttentionProvider, useAttentionProvider } from '@/hooks/use-attention'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Only the Overview route matches exactly; others match by prefix. */
  end?: boolean
  /** Onboarding-tour anchor id (sets `data-tour` on the nav link). */
  tour?: string
  /** Route key the update badge should attach to (v0.3.3). The Settings icon
   *  shows a small dot when `useUpdateBadge` reports an actionable state. */
  badgeKind?: 'updates'
  /** Render this item ONLY in the desktop SideNav, not the mobile BottomNav.
   *  Used by the Focus entry — on mobile the natural way into a session is
   *  tapping a tile, so a primary-nav slot would be redundant. On desktop it
   *  lets the user jump straight back to the last-focused session from any
   *  route. */
  desktopOnly?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  // Focus — desktop-only entry that redirects to /focus/<last-active-session>
  // (see [[FocusEntry]] in routes/focus.tsx). `end: false` (default) so the
  // item stays highlighted while you're on any /focus/* sub-route. The
  // Terminal glyph (>_) matches the abstract-geometric rest of the rail and
  // names what focus mode IS — sitting inside a terminal session.
  { to: '/focus', label: 'Focus', icon: Terminal, desktopOnly: true },
  { to: '/files', label: 'Files', icon: FolderClosed },
  // Hosts registry AND the scheduler both moved into Settings (rare-use config
  // doesn't need a primary-nav slot). `/hosts` → /settings#hosts and
  // `/scheduler` → /settings#schedules (App.tsx) so old bookmarks land in the
  // right section. Settings therefore carries the onboarding tour's step-3
  // anchor, which used to point at the Scheduler item.
  // Nav is at FOUR items after B2: the Board page left once issues became
  // reachable from the session that owns them (and from the team card). The
  // deletion keyed on `to === '/board'`, never on an index — one removal, both
  // surfaces (SideNav + BottomNav).
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    tour: 'settings',
    badgeKind: 'updates',
  },
]

/** Tiny notification dot rendered over a nav icon. The colour distinguishes
 *  "available + clean" (primary tint, classic blue dot) from "available but
 *  action needed" (amber, matches the panel's blocked-state pill). Sized so
 *  it overlaps the icon by ~2px without obscuring it. */
function NavBadgeDot({ state }: { state: UpdateBadgeState }) {
  if (state === 'none') return null
  return (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute h-2 w-2 rounded-full ring-2 ring-card',
        // Position varies between rail (desktop, icon centered in 44px tile)
        // and tab (mobile, icon centered with label below it). The shell-level
        // wrappers below set sensible defaults via class merging.
        state === 'available-blocked'
          ? 'bg-amber-500'
          : 'bg-primary',
      )}
    />
  )
}

/** Desktop: 64px icon rail (≥md). Tooltip reveals each label. */
function SideNav() {
  const { state: updateBadge } = useUpdateBadge()
  return (
    <nav
      aria-label="Primary"
      // `data-shell-rail` is the substrate hook (B1 T3): under
      // `[data-substrate]` globals.css repaints this column onto `--sm-paper`,
      // drops the 1px border and draws a 0.5px `::after` hairline instead. The
      // Tailwind classes stay so removing the attribute is a true one-attribute
      // revert to the pre-B1 look.
      data-shell-rail=""
      className="hidden w-16 shrink-0 flex-col items-center border-r border-border bg-card pb-4 pt-safe md:flex"
    >
      <div className="flex h-16 w-full items-center justify-center">
        <Logo className="h-7 w-auto" />
      </div>
      <div className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((item) => {
          const badge = item.badgeKind === 'updates' ? updateBadge : 'none'
          return (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>
                <MorphNavLink
                  to={item.to}
                  end={item.end}
                  aria-label={
                    badge !== 'none' ? `${item.label} (update available)` : item.label
                  }
                  data-tour={item.tour}
                  className="group relative flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-primary-foreground"
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span
                          data-nav-active=""
                          // B1 T4 — the pill is a VIEW-TRANSITION-named element,
                          // not a framer `layoutId`. See NAV_ACTIVE_VT_NAME for
                          // why: with nav clicks running inside
                          // startViewTransition, layoutId double-animates (a
                          // frozen snapshot sliding under a live spring).
                          style={{ viewTransitionName: NAV_ACTIVE_VT_NAME }}
                          className="absolute inset-0 rounded-xl bg-primary"
                        />
                      )}
                      <item.icon className="relative size-5" />
                      {/* Desktop: place the dot at the icon's top-right corner.
                       *  inset-y centred on the icon: top ~10px, right ~10px so
                       *  it sits just outside the 20px icon glyph. */}
                      <span className="pointer-events-none absolute right-[10px] top-[10px]">
                        <NavBadgeDot state={badge} />
                      </span>
                    </>
                  )}
                </MorphNavLink>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <ThemeToggle />
    </nav>
  )
}

/** Mobile chrome above the route outlet (≤md).
 *
 *  MHDR: renders nothing on mobile for EVERY route — including overview (`/`).
 *  The overview used to float a minimal top-right `<ThemeToggle />` pinned to
 *  the safe-area corner (commit b5c8f14), but that floating control crowded the
 *  overview header (it reserved a `pr-12` corner) and is redundant: the theme
 *  control already lives in Settings → Appearance (settings.tsx, backed by the
 *  same `supermux-theme` localStorage source as the desktop SideNav toggle).
 *  Every mobile route — overview included — self-homes its own `pt-safe` inset
 *  (overview.tsx folds it into the body's top padding) so content still clears
 *  the notch / Dynamic Island without any shell-level top band.
 *  Desktop SideNav keeps its ThemeToggle untouched.
 *
 *  Focus (`/focus/:name`) renders nothing at all (gated out in <Layout>). */
function MobileTopBar(_props: { overview: boolean }) {
  // No mobile top chrome on any route — see the block comment above. Each route
  // owns its safe-area inset, and the theme control lives in Settings.
  return null
}

/** Mobile: bottom tab bar, safe-area inset (≤md). Filters out `desktopOnly`
 *  items so the mobile chrome stays at its 5-tab footprint — on mobile the
 *  natural way into a focused session is tapping a tile in Overview. */
function BottomNav() {
  const { state: updateBadge } = useUpdateBadge()
  return (
    <nav
      aria-label="Primary"
      // Substrate hook — same contract as the desktop rail, hairline on top.
      data-shell-tabs=""
      className="flex shrink-0 items-stretch justify-around border-t border-border bg-card pb-safe md:hidden"
    >
      {NAV.filter((item) => !item.desktopOnly).map((item) => {
        const badge = item.badgeKind === 'updates' ? updateBadge : 'none'
        return (
          <MorphNavLink
            key={item.to}
            to={item.to}
            end={item.end}
            aria-label={
              badge !== 'none' ? `${item.label} (update available)` : item.label
            }
            data-tour={item.tour}
            className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-muted-foreground transition-colors aria-[current=page]:text-primary"
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span
                    data-nav-active=""
                    // Same contract as the desktop pill — one VT name per
                    // snapshot. Desktop and mobile nav are mutually exclusive
                    // (`hidden md:flex` vs `md:hidden`), so a `display: none`
                    // nav is never captured and the name stays unique.
                    style={{ viewTransitionName: NAV_ACTIVE_VT_NAME }}
                    className="absolute left-1/2 top-1.5 h-1 w-8 -translate-x-1/2 rounded-full bg-primary"
                  />
                )}
                <span className="relative">
                  <item.icon className="size-5" />
                  {/* Mobile: dot at the icon's top-right (the icon is the
                   *  positioning anchor; the label sits below it). */}
                  <span className="pointer-events-none absolute -right-1 -top-1">
                    <NavBadgeDot state={badge} />
                  </span>
                </span>
                <span className="text-[10px] font-medium leading-none">
                  {item.label}
                </span>
              </>
            )}
          </MorphNavLink>
        )
      })}
    </nav>
  )
}

/** App shell: side-nav (desktop) / top + bottom nav (mobile) wrapping the route
 *  outlet. The <ReconnectBanner> is mounted ONCE here, at shell level, so the
 *  global connection-status surface floats above every route — pinned to the
 *  safe-area top, independent of the route's own scroll.
 *
 *  When launched as an installed PWA (`useStandaloneMode()`), the OS owns the
 *  window chrome, so `data-standalone` is set on the shell root — routes can
 *  key off it (e.g. to drop browser-only back affordances). The `pt-safe` /
 *  `pb-safe` insets already handle the notch + Dynamic Island in both modes.
 *
 *  The <ReconnectBanner> is an IN-FLOW row at the top of the content column —
 *  above <main>, below the mobile top bar — so when it is visible it reserves
 *  vertical space and pushes the route (and its own header chrome) down. It is
 *  never an overlay, so it can never collide with a route header's view-toggle
 *  / search / "New session" controls at any breakpoint. */
export function Layout() {
  const standalone = useStandaloneMode()
  // Register the shared SSE channel with the global connection-store exactly
  // once, at shell level. Previously this lived in `useSessions`, which
  // could be mounted from multiple routes simultaneously — racing reports under
  // the same `'sse'` id let last-write-wins flip the banner's view of stream
  // health. The singleton SSE client (use-sse.ts) is the source of truth.
  const { status: sseStatus } = useSseStatus()
  useSseConnectionLink(sseStatus)
  // Route-aware mobile chrome (Fix 1b / Fix 3). The focus route is a full-screen
  // experience: the shell's mobile top bar AND bottom tab bar must NOT be in its
  // tree, or they leak out from under the Vaul sheet when the keyboard opens and
  // read as duplicate toolbars. The overview route keeps the top bar but in its
  // collapsed top-right-icon form. (Desktop SideNav is unaffected — it has no
  // focus-route chrome to leak.)
  const { pathname } = useLocation()
  const isFocus = pathname.startsWith('/focus/')
  const isOverview = pathname === '/'
  // Archived sheet open-state lives in a shared store so the ⌘K command and the
  // overview overflow item open the same shell-mounted instance (no permanent
  // estate — the sheet is only in the DOM as an overlay when opened).
  const archivedOpen = useArchivedSheet((s) => s.open)
  const setArchivedOpen = useArchivedSheet((s) => s.setOpen)
  // Kill switch, read ONCE at mount (see the attribute below).
  const [substrate] = React.useState(isShellSubstrateEnabled)
  // The shell-overlay host: the content column, published on context so any
  // route can raise a <ShellOverlay> without prop-drilling and without a
  // body-level portal (which could not be bounded by the column).
  const [attachOverlayHost, overlayHostValue] = useShellOverlayProvider()
  // The roster's faces, assigned ONCE for the whole app (fase B2 T2). Dedupe is
  // a property of the roster, not of a row, so it cannot live in the row — and
  // it is mounted here, above every route, because the palette, the pickers and
  // the focus strip all draw marks outside the overview's tree.
  const rosterMarks = useRosterMarksProvider()
  // The attention tiers (fase B2 T5), for the same reason: the rows that draw a
  // tier sit five layers under the surface that owns the roster, and the header
  // rollup needs the same answer the rows got.
  const attention = useAttentionProvider()
  return (
    <RosterMarksProvider value={rosterMarks}>
    <AttentionProvider value={attention}>
    <ShellOverlayProvider value={overlayHostValue}>
    <div
      className="flex h-full w-full"
      data-standalone={standalone ? '' : undefined}
      // B1 T3 — the painted substrate. One attribute gates the whole layer
      // (globals.css scopes every substrate rule under `[data-substrate]`), so
      // `localStorage['supermux:shell-substrate'] = '0'` + reload is a complete
      // revert to the pre-B1 appearance with no redeploy. Read once, at mount:
      // the flag is a kill switch, not a preference, and must not re-render.
      data-substrate={substrate ? '' : undefined}
    >
      <SideNav />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {!isFocus && <MobileTopBar overview={isOverview} />}
        <ReconnectBanner />
        {/* The content column. `data-shell-content` raises it one step off the
            paper under the substrate; it is also the host `<ShellOverlay>`
            mounts into (see components/shell/use-shell-overlay.ts). */}
        <main
          ref={attachOverlayHost}
          data-shell-content=""
          className={cn('min-h-0 flex-1 overflow-auto')}
        >
          <Outlet />
        </main>
        {!isFocus && <BottomNav />}
      </div>
      {/* The global ⌘K command palette. Mounted ONCE at shell level so the
       *  shortcut works on EVERY route (overview, board, files, scheduler,
       *  settings, focus). Previously this was a per-route stub that only logged
       *  to the console — opening Cmd+K did nothing visible. The palette owns
       *  its own document-level keydown capture + preventDefault. */}
      <CommandPalette />
      {/* feat-archive-recover: the Archived sessions sheet, mounted ONCE at
       *  shell level so the ⌘K "View archived sessions" command and the overview
       *  overflow item open the same instance. Opt-in — zero always-on estate
       *  (it's only in the DOM as an overlay while open). */}
      <ArchivedSheet open={archivedOpen} onOpenChange={setArchivedOpen} />
    </div>
    </ShellOverlayProvider>
    </AttentionProvider>
    </RosterMarksProvider>
  )
}
