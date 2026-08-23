import * as React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import {
  FolderClosed,
  LayoutGrid,
  Plug,
  Search,
  Settings as SettingsIcon,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { isShellSubstrateEnabled } from '@/lib/shell-substrate-flag'
import { botModeOn, BOT_KILL_SWITCH_KEY } from '@/lib/bot-mode-flag'
import { GROK_KILL_SWITCH_KEY } from '@/lib/grok-mode-flag'
import { agentHueVarsFor } from '@/lib/grok-agent-hue'
import { useUI } from '@/stores/ui-store'
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
import { useTheme } from '@/components/theme-provider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReconnectBanner } from '@/components/status-banner/reconnect-banner'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { triggerCommandPalette } from '@/components/command-palette/trigger'
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
import { useViewportShellVars } from '@/hooks/use-keyboard-viewport'

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
  /** Hide this item under the Grok skin (`[data-grok]`). BOTH nav surfaces honour
   *  it — the desktop SideNav (filter) and the mobile BottomNav (filter) — so a
   *  `grokHidden` item drops from the rail AND the phone tab bar under grok.
   *  Base app (grok off) keeps it. Set on the Focus entry (under grok the roster
   *  IS the way into a thread, so the rail's Focus redirect is redundant — and
   *  Focus is `desktopOnly` so mobile drops it either way) and on Settings
   *  (under grok the top-right `.gr-me` avatar is the Settings doorway). */
  grokHidden?: boolean
  /** Render this item ONLY under the Grok skin (`[data-grok]`), on BOTH the
   *  desktop SideNav and the mobile BottomNav. The inverse of `grokHidden`:
   *  used by the Grok-native nav doorways that the BASE app must never grow —
   *  the Connector-store entry (`/store`) and the phone-nav Terminal doorway
   *  (`/focus`). Both navs filter these out when grok is off, so the default
   *  app is byte-identical (the store/terminal stay reachable there via the
   *  command palette + Settings, exactly as before). */
  grokOnly?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  // Focus — desktop-only entry that redirects to /focus/<last-active-session>
  // (see [[FocusEntry]] in routes/focus.tsx). `end: false` (default) so the
  // item stays highlighted while you're on any /focus/* sub-route. The
  // Terminal glyph (>_) matches the abstract-geometric rest of the rail and
  // names what focus mode IS — sitting inside a terminal session.
  { to: '/focus', label: 'Focus', icon: Terminal, desktopOnly: true, grokHidden: true },
  // Connectors — the Connector-store entry (#22). The store is a fully built
  // route (/store) that had NO nav surface at all; this `grokOnly` item makes it
  // a first-class Grok destination on the rail and the phone nav (Plug glyph,
  // the same mark the command palette already uses for it). Base app unchanged.
  { to: '/store', label: 'Connectors', icon: Plug, grokOnly: true },
  { to: '/files', label: 'Files', icon: FolderClosed },
  // Hosts registry AND the scheduler both moved into Settings (rare-use config
  // doesn't need a primary-nav slot). `/hosts` → /settings#hosts and
  // `/scheduler` → /settings#schedules (App.tsx) so old bookmarks land in the
  // right section. Settings therefore carries the onboarding tour's step-3
  // anchor, which used to point at the Scheduler item.
  // The Board page left after B2 (issues became reachable from the session that
  // owns them and from the team card); the deletion keyed on `to === '/board'`,
  // never on an index — one removal, both surfaces (SideNav + BottomNav). The
  // base rail is FOUR items (Overview / Focus / Files / Settings); the array also
  // carries the `grokOnly` `/store` doorway above, filtered per mode.
  {
    to: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    tour: 'settings',
    badgeKind: 'updates',
    // Under grok the roster's top-right `.gr-me` avatar IS the Settings doorway
    // (grok-roster.tsx — `onClick navigate('/settings')`), and the Settings
    // route grows its own close-X, so a redundant nav slot only crowds the
    // grok rail/tab bar. Both nav surfaces honour `grokHidden`, so the item
    // drops from the rail AND the phone tabs under grok; the base app (grok
    // off) keeps Settings in nav exactly as before (byte-identical). The
    // update-available dot this item used to host is re-homed onto the avatar
    // (grok-roster.tsx) so the update tell survives its removal.
    grokHidden: true,
  },
]

/** Tiny notification dot rendered over a nav icon. The colour distinguishes
 *  "available + clean" (primary tint, classic blue dot) from "available but
 *  action needed" (amber, matches the panel's blocked-state pill). Sized so
 *  it overlaps the icon by ~2px without obscuring it. */
export function NavBadgeDot({ state }: { state: UpdateBadgeState }) {
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

/** Desktop: 64px icon rail (≥md). Tooltip reveals each label. Under the Grok
 *  skin the Focus item is filtered out (`grokHidden`) — the roster owns thread
 *  entry, so the rail carries only Overview / Files / Settings. */
function SideNav({ grok }: { grok: boolean }) {
  const { state: updateBadge } = useUpdateBadge()
  // grok: drop `grokHidden` (base Focus) and keep the `grokOnly` doorways
  // (Terminal + Connectors). base: drop the `grokOnly` doorways so the default
  // rail is byte-identical (Overview / Focus / Files / Settings).
  const items = grok
    ? NAV.filter((item) => !item.grokHidden)
    : NAV.filter((item) => !item.grokOnly)
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
        {items.map((item) => {
          const badge = item.badgeKind === 'updates' ? updateBadge : 'none'
          return (
            <Tooltip key={item.label}>
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
function BottomNav({ grok }: { grok: boolean }) {
  const { state: updateBadge } = useUpdateBadge()
  // Always drop `desktopOnly` (base Focus). Under grok, keep the `grokOnly`
  // doorway (Connectors) and drop `grokHidden`; under base, drop the `grokOnly`
  // doorways so the default tab bar is byte-identical (Overview / Files /
  // Settings + the Search control). The `data-tab-count` (route cells + the
  // Search button) + `--nav-n` let grok-mode.css place the sliding pill.
  const items = NAV.filter(
    (item) => !item.desktopOnly && (grok ? !item.grokHidden : !item.grokOnly),
  )
  // ── The sliding-pill driver (grok phone nav, "Liquid Rail") ────────────────
  //  The active-indicator is ONE persistent pill (`data-nav-pill`, painted below
  //  the cells) translated by whole cells via a single `--nav-i` custom prop and
  //  a plain CSS `transform` transition — no framer-motion, no FLIP, no measure,
  //  no ResizeObserver. `activeIndex` is the index of the matched ROUTE cell, or
  //  -1 when the active route isn't in the bar (chromeful sub-route) — the pill
  //  is hidden then. Same `end`/prefix rule react-router's NavLink uses, so the
  //  pill parks under exactly the cell that shows `aria-current="page"`.
  const { pathname } = useLocation()
  const activeIndex = grok
    ? items.findIndex((item) =>
        item.end
          ? pathname === item.to
          : pathname === item.to || pathname.startsWith(`${item.to}/`),
      )
    : -1
  // Tap-drive: on tap, set `--nav-i` on the live <nav> BEFORE react-router
  // commits the route, so the pill starts gliding <100ms while the route
  // transition runs underneath. The `style` prop below re-asserts the same value
  // from `activeIndex` once the route commits (idempotent). Cheap haptic tick on
  // supporting devices; silently absent on iOS Safari.
  const navRef = React.useRef<HTMLElement | null>(null)
  const onNavTap = React.useCallback(
    (index: number) => {
      if (!grok) return
      navRef.current?.style.setProperty('--nav-i', String(index))
      navigator.vibrate?.(8)
    },
    [grok],
  )
  return (
    <nav
      ref={navRef}
      aria-label="Primary"
      // Substrate hook — same contract as the desktop rail, hairline on top.
      data-shell-tabs=""
      // grok-only hooks. `data-tab-count` keeps the capsule geometry; `--nav-i`
      // (active cell index) + `--nav-n` (cell count) drive the sliding pill in
      // grok-mode.css. All omitted off grok (`undefined` drops the attribute /
      // no style) so the base tab bar's DOM + render are byte-identical.
      data-tab-count={grok ? items.length + 1 : undefined}
      style={
        grok
          ? ({
              '--nav-i': activeIndex,
              '--nav-n': items.length + 1,
            } as React.CSSProperties)
          : undefined
      }
      className="flex shrink-0 items-stretch justify-around border-t border-border bg-card pb-safe md:hidden"
    >
      {/* THE HERO — one persistent pill for the whole bar (grok only). NOT a
          view-transition element: it slides on the live DOM via a plain CSS
          `transform` transition, which sidesteps the WebKit backdrop-filter
          snapshot artifact that forced the old chip to cross-fade. Painted
          BELOW the cells (z-0; cells are z-1 in grok CSS). Hidden when no route
          cell is active (`activeIndex < 0`). */}
      {grok && activeIndex >= 0 && <span data-nav-pill="" aria-hidden="true" />}
      {items.map((item) => {
        const badge = item.badgeKind === 'updates' ? updateBadge : 'none'
        const idx = items.indexOf(item)
        return (
          <MorphNavLink
            key={item.label}
            to={item.to}
            end={item.end}
            onClick={() => onNavTap(idx)}
            aria-label={
              badge !== 'none' ? `${item.label} (update available)` : item.label
            }
            data-tour={item.tour}
            className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-muted-foreground transition-colors aria-[current=page]:text-primary"
          >
            {({ isActive }) => (
              <>
                {/* BASE active mark — the Material top-underline. Kept for the
                    base render; grok-mode.css hides it (the sliding pill is the
                    grok indicator) so it never double-draws. */}
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
                  {/* `data-active` (grok only) lets grok-mode.css apply the
                      outline→filled tell + lift on the active glyph; base CSS
                      ignores it and it is absent off grok (byte-identical). */}
                  <item.icon
                    className="size-5"
                    data-active={grok && isActive ? '' : undefined}
                  />
                  {/* Mobile: dot at the icon's top-right (the icon is the
                   *  positioning anchor; the label sits below it). */}
                  <span className="pointer-events-none absolute -right-1 -top-1">
                    <NavBadgeDot state={badge} />
                  </span>
                </span>
                <span
                  data-nav-label={grok ? '' : undefined}
                  className="text-[10px] font-medium leading-none"
                >
                  {item.label}
                </span>
              </>
            )}
          </MorphNavLink>
        )
      })}
      {/* SEARCH — a control, not a route, and the reason it is here: ⌘K was
          unreachable on a phone. Every trigger the palette had lived in the
          DESKTOP dock, so enumerating every visible control at 390×844
          returned nothing matching /palette|search|command|jump/ and the app's
          discovery spine could only be opened by a physical keyboard. Styled
          as a tab so the row stays one grammar; it carries no `aria-current`
          because it goes nowhere — the pill never parks on it. */}
      <button
        type="button"
        aria-label="Search"
        data-vr="bottom-nav-search"
        onClick={triggerCommandPalette}
        className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-muted-foreground transition-colors active:text-foreground"
      >
        <span className="relative">
          <Search className="size-5" />
        </span>
        <span
          data-nav-label={grok ? '' : undefined}
          className="text-[10px] font-medium leading-none"
        >
          Search
        </span>
      </button>
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
  // Layout foundation (Piece 1): the SINGLE keyboard/safe-area coordinator.
  // Publishes --vvh / --vv-offset-top / --kb / --kb-safe-bottom to the shell
  // root so every bottom-anchored surface reads one source of truth. Additive
  // and, until a surface consumes the vars, a visual no-op. Mounted ONCE here.
  useViewportShellVars()
  // Route-aware mobile chrome (Fix 1b / Fix 3). The focus route is a full-screen
  // experience: the shell's mobile top bar AND bottom tab bar must NOT be in its
  // tree, or they leak out from under the Vaul sheet when the keyboard opens and
  // read as duplicate toolbars. The overview route keeps the top bar but in its
  // collapsed top-right-icon form. (Desktop SideNav is unaffected — it has no
  // focus-route chrome to leak.)
  const { pathname } = useLocation()
  const isFocus = pathname.startsWith('/focus/')
  const isOverview = pathname === '/'
  // The phone `/team/*` detail (Phase 6a) is a full-bleed surface like focus — no
  // top bar, no bottom nav, no `<main>` page-scroll. It is NOT a focus session,
  // so it stays out of `isFocus` (which drives the `/focus/` slug + agent hue);
  // `chromeless` is the shared "this route paints the whole window" gate. Base app
  // never routes here (the route redirects when bot mode is off), so every
  // existing path keeps `chromeless === isFocus` exactly.
  const isTeamDetail = pathname.startsWith('/team/')
  const chromeless = isFocus || isTeamDetail
  // Archived sheet open-state lives in a shared store so the ⌘K command and the
  // overview overflow item open the same shell-mounted instance (no permanent
  // estate — the sheet is only in the DOM as an overlay when opened).
  const archivedOpen = useArchivedSheet((s) => s.open)
  const setArchivedOpen = useArchivedSheet((s) => s.setOpen)
  // Kill switch, read ONCE at mount (see the attribute below).
  const [substrate] = React.useState(isShellSubstrateEnabled)
  // Grok mode (WS1) — the app-wide skin flag. Read ONCE at mount, non-reactively
  // (`useUI.getState()`, not a selector subscription): a skin flip is a
  // reload-level change like the substrate kill-switch, not a live re-render, so
  // toggling it in Settings takes effect on the next reload and never thrashes a
  // live session mid-flight. The store field is the user preference; the
  // `localStorage['supermux:grok-mode']` kill-switch ('0') overrides it.
  const [grok] = React.useState(() =>
    botModeOn(
      useUI.getState().botMode,
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(BOT_KILL_SWITCH_KEY),
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(GROK_KILL_SWITCH_KEY),
    ),
  )
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
  // WS4 — the per-agent hue write. The focused session's identity colour is
  // written as the five `--sm-agent-*` custom properties on the shell root, so
  // one property write re-skins the ~6 non-semantic surfaces that read the
  // family (side-pane wash, mention chips, composer ring, thinking coat). Derived
  // from the IMMUTABLE slug (`/focus/:name` is the slug) + the session's deduped
  // roster pin (so the shell wears the same hue slot the on-screen mark does),
  // theme-resolved here where `useTheme` is in scope. Only under grok, only on a
  // focus route: off grok, or on the overview (no single focused session), the
  // object is empty and the shell inherits grok-mode.css's neutral defaults —
  // which keeps the firewall honest (two focused sessions differ ONLY on these
  // accent surfaces; the neutral page/rail stays byte-identical).
  const { resolvedTheme } = useTheme()
  const focusName = isFocus
    ? decodeURIComponent(pathname.slice('/focus/'.length).split('/')[0] || '')
    : undefined
  const agentHueStyle =
    grok && focusName
      ? agentHueVarsFor({ name: focusName }, resolvedTheme === 'dark', rosterMarks.pinFor(focusName))
      : undefined
  return (
    <RosterMarksProvider value={rosterMarks}>
    <AttentionProvider value={attention}>
    <ShellOverlayProvider value={overlayHostValue}>
    <div
      className="flex h-full w-full"
      // WS4 — the focused session's `--sm-agent-*` hue (empty off grok / off a
      // focus route, so no inline properties are set and the shell inherits the
      // neutral defaults). Custom-property values only — never a background or a
      // status colour — so the firewall holds.
      style={agentHueStyle}
      data-standalone={standalone ? '' : undefined}
      // B1 T3 — the painted substrate. One attribute gates the whole layer
      // (globals.css scopes every substrate rule under `[data-substrate]`), so
      // `localStorage['supermux:shell-substrate'] = '0'` + reload is a complete
      // revert to the pre-B1 appearance with no redeploy. Read once, at mount:
      // the flag is a kill switch, not a preference, and must not re-render.
      //
      // WS2 — grok mode is a FULL shell skin that SUPERSEDES the substrate paint,
      // so the two are mutually exclusive: when grok is on we drop `data-substrate`
      // entirely. Both skins scope their column rules at the same specificity
      // (`[data-attr] [data-shell-*]`), and the substrate block sits LATER in
      // globals.css than the `@import "./grok-mode.css"`, so with both attributes
      // present the substrate paper would win every shared property (rail/content
      // background, border-width, the hairline `::after`) and the grok tints would
      // never show. Dropping it here (rather than fighting the cascade with
      // inflated selectors) keeps each skin's rules clean and keeps "grok off" a
      // byte-exact today (substrate stays on exactly as before).
      data-substrate={substrate && !grok ? '' : undefined}
      // WS1 — the Grok-mode skin gate. One attribute keys the entire scoped
      // token layer (styles/grok-mode.css, every rule under `[data-grok]`); the
      // dark half swaps via `.dark [data-grok]` (theme is a `.dark` class on
      // <html>). Absent by default, so removing it is a byte-exact revert to
      // today's app with no rebuild — the same guarantee `data-substrate` gives.
      data-grok={grok ? '' : undefined}
      // WS7 fix — the SHELL-ROOT hook. `data-grok` alone is NOT unique to this
      // element: the ⌘K command palette is a Radix Dialog PORTALLED to <body>
      // that stamps its OWN `data-grok` (command-palette.tsx) so the token/skin
      // layer reaches it. The STRUCTURAL rules in grok-mode.css that assume "this
      // element IS the full-window ground" (position:relative clobbering the
      // portalled .fixed, and the `::before` glass substrate painting over the
      // palette's list) must match the ground ONLY — so they are scoped
      // `[data-grok][data-grok-root]`. This marks the one true ground. Byte-inert
      // when grok is off (absent), so the default app is untouched.
      data-grok-root={grok ? '' : undefined}
    >
      {/* THE SKIP LINK (fase A6 T7.6 — gap G10). Zero existed app-wide, so
          every route made a keyboard user tab through the whole side nav, the
          mobile top bar and the bottom nav before reaching a single message.
          First in DOM order so it is the first stop, invisible until focused,
          and it targets `<main>` (which takes `tabIndex={-1}` below so the jump
          actually moves focus rather than only the scroll position). */}
      <a
        href="#shell-content"
        className="sr-only bg-background px-4 py-2 text-sm font-medium ring-2 ring-ring focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to content
      </a>
      <SideNav grok={grok} />
      {/* `data-shell-main` — the content-column wrapper, the rail's sibling. A
          WS2 (Grok-mode) hook, mirroring the `data-shell-*` convention: under
          `[data-grok]` it is lifted above the substrate pseudo (z:1) and rounds
          its outer-right corners into the desktop floating window. Inert with no
          styling attached in the default app — layout-neutral. */}
      <div data-shell-main="" className="flex h-full min-w-0 flex-1 flex-col">
        {!chromeless && <MobileTopBar overview={isOverview} />}
        <ReconnectBanner />
        {/* The content column. `data-shell-content` raises it one step off the
            paper under the substrate; it is also the host `<ShellOverlay>`
            mounts into (see components/shell/use-shell-overlay.ts). */}
        <main
          ref={attachOverlayHost}
          id="shell-content"
          // The skip link's target. `-1` so focus really lands here — an anchor
          // to a non-focusable element scrolls and leaves the tab cursor where
          // it was, which is the failure mode that makes skip links look like
          // they work and not help anyone.
          tabIndex={-1}
          data-shell-content=""
          // `overflow-auto` for every route EXCEPT focus (bug C, belt to the
          // inner scrollers' `overscroll-contain`). Overview is a long page and
          // needs this shared scroller; the focus split is a fixed full-screen
          // rail + pane surface that should never page-scroll — yet it lives in
          // the same `<main>`, so any 1px overflow (or a chained wheel delta)
          // makes `<main>` the scroll/chain target and drags the whole shell.
          // `overflow-hidden` when `isFocus` removes that target entirely, which
          // also covers pre-Safari-16 (where `overscroll-behavior` is a no-op).
          // Platform-neutral: on mobile the focus route's sheet is `position:
          // fixed` (out of `<main>`'s flow), so clipping `<main>` changes nothing.
          className={cn('min-h-0 flex-1', chromeless ? 'overflow-hidden' : 'overflow-auto')}
        >
          <Outlet />
        </main>
        {!chromeless && <BottomNav grok={grok} />}
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
