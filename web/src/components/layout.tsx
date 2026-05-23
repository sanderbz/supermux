import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  CalendarClock,
  FolderClosed,
  LayoutGrid,
  Settings as SettingsIcon,
  SquareKanban,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { ThemeToggle } from '@/components/theme-toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ReconnectBanner } from '@/components/status-banner/reconnect-banner'
import { CommandPalette } from '@/components/command-palette/command-palette'
import { useStandaloneMode } from '@/hooks/use-standalone-mode'
import { useSseStatus } from '@/hooks/use-sse'
import { useSseConnectionLink } from '@/hooks/use-connection-link'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Only the Overview route matches exactly; others match by prefix. */
  end?: boolean
  /** M27 onboarding-tour anchor id (sets `data-tour` on the nav link). */
  tour?: string
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/board', label: 'Board', icon: SquareKanban },
  { to: '/files', label: 'Files', icon: FolderClosed },
  { to: '/scheduler', label: 'Scheduler', icon: CalendarClock, tour: 'scheduler' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

/** Desktop: 64px icon rail (≥md). Tooltip reveals each label. */
function SideNav() {
  return (
    <nav
      aria-label="Primary"
      className="hidden w-16 shrink-0 flex-col items-center border-r border-border bg-card pb-4 pt-safe md:flex"
    >
      <div className="flex h-16 w-full items-center justify-center">
        <span className="text-lg font-semibold tracking-tight">a</span>
      </div>
      <div className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((item) => (
          <Tooltip key={item.to}>
            <TooltipTrigger asChild>
              <NavLink
                to={item.to}
                end={item.end}
                aria-label={item.label}
                data-tour={item.tour}
                className="group relative flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-primary-foreground"
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId="nav-active-desktop"
                        transition={springs.snappy}
                        className="absolute inset-0 rounded-xl bg-primary"
                      />
                    )}
                    <item.icon className="relative size-5" />
                  </>
                )}
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <ThemeToggle />
    </nav>
  )
}

/** Mobile chrome above the route outlet (≤md).
 *
 *  Overview (`/`): a minimal top-right ThemeToggle pinned to the safe-area
 *  corner — no in-flow band. The overview body re-homes its own `pt-safe`
 *  (overview.tsx) so its content still clears the notch / Dynamic Island.
 *  This was commit b5c8f14.
 *
 *  R5: every OTHER non-focus route (board / scheduler / settings / files)
 *  used to render a full `h-12 + pt-safe` band carrying just a `supermux`
 *  wordmark + a redundant ThemeToggle — wasted vertical space, since each of
 *  those routes already self-renders its own header/title and the theme
 *  control already lives in Settings → Appearance (settings.tsx, backed by the
 *  same `supermux-theme` localStorage source as the desktop SideNav toggle).
 *  So we drop the band entirely and return `null` for those routes; each route
 *  absorbs its own mobile `pt-safe` inset (matching overview.tsx) so its header
 *  still clears the notch. Desktop SideNav keeps its ThemeToggle untouched.
 *
 *  Focus (`/focus/:name`) renders nothing at all (gated out in <Layout>). */
function MobileTopBar({ overview }: { overview: boolean }) {
  if (!overview) return null
  // Minimal corner affordance — no in-flow band. `top` clears the notch via
  // the same safe-area inset the old bar's pt-safe used; the overview body
  // re-homes its own pt-safe so nothing slides under the Dynamic Island.
  return (
    <div className="pointer-events-none fixed right-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 md:hidden">
      <div className="pointer-events-auto">
        <ThemeToggle />
      </div>
    </div>
  )
}

/** Mobile: bottom tab bar, 5 icons + label, safe-area inset (≤md). */
function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 items-stretch justify-around border-t border-border bg-card pb-safe md:hidden"
    >
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          aria-label={item.label}
          data-tour={item.tour}
          className="relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-2 text-muted-foreground transition-colors aria-[current=page]:text-primary"
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span
                  layoutId="nav-active-mobile"
                  transition={springs.snappy}
                  className="absolute left-1/2 top-1.5 h-1 w-8 -translate-x-1/2 rounded-full bg-primary"
                />
              )}
              <item.icon className="size-5" />
              <span className="text-[10px] font-medium leading-none">
                {item.label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

/** App shell: side-nav (desktop) / top + bottom nav (mobile) wrapping the route
 *  outlet. §M10 / §4.8. The <ReconnectBanner> (§M23a) is mounted ONCE here, at
 *  shell level, so the global connection-status surface floats above every
 *  route — pinned to the safe-area top, independent of the route's own scroll.
 *
 *  M23b: when launched as an installed PWA (`useStandaloneMode()`), the OS owns
 *  the window chrome, so `data-standalone` is set on the shell root — routes can
 *  key off it (e.g. to drop browser-only back affordances). The `pt-safe` /
 *  `pb-safe` insets already handle the notch + Dynamic Island in both modes.
 *
 *  M27: the <ReconnectBanner> is an IN-FLOW row at the top of the content
 *  column — above <main>, below the mobile top bar — so when it is visible it
 *  reserves vertical space and pushes the route (and its own header chrome)
 *  down. It is never an overlay, so it can never collide with a route header's
 *  view-toggle / search / "New session" controls at any breakpoint. */
export function Layout() {
  const standalone = useStandaloneMode()
  // R3-202: register the shared SSE channel with the global connection-store
  // exactly once, at shell level. Previously this lived in `useSessions`, which
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
  return (
    <div
      className="flex h-full w-full"
      data-standalone={standalone ? '' : undefined}
    >
      <SideNav />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {!isFocus && <MobileTopBar overview={isOverview} />}
        <ReconnectBanner />
        <main className={cn('min-h-0 flex-1 overflow-auto')}>
          <Outlet />
        </main>
        {!isFocus && <BottomNav />}
      </div>
      {/* M9/M50: the global ⌘K command palette. Mounted ONCE at shell level so
       *  the shortcut works on EVERY route (overview, board, files, scheduler,
       *  settings, focus). Previously this was a per-route stub that only logged
       *  to the console — opening Cmd+K did nothing visible. The palette owns
       *  its own document-level keydown capture + preventDefault. */}
      <CommandPalette />
    </div>
  )
}
