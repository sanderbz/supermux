import { NavLink, Outlet } from 'react-router-dom'
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

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Only the Overview route matches exactly; others match by prefix. */
  end?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/board', label: 'Board', icon: SquareKanban },
  { to: '/files', label: 'Files', icon: FolderClosed },
  { to: '/scheduler', label: 'Scheduler', icon: CalendarClock },
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

/** Mobile: top app bar with brand + theme toggle (≤md). */
function MobileTopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4 pt-safe md:hidden">
      <span className="text-base font-semibold tracking-tight">amux</span>
      <ThemeToggle />
    </header>
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
 *  route — pinned to the safe-area top, independent of the route's own scroll. */
export function Layout() {
  return (
    <div className="flex h-full w-full">
      <ReconnectBanner />
      <SideNav />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <MobileTopBar />
        <main className={cn('min-h-0 flex-1 overflow-auto')}>
          <Outlet />
        </main>
        <BottomNav />
      </div>
    </div>
  )
}
