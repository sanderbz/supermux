import { useMediaQuery } from '@/hooks/use-media-query'
import { DesktopFocus } from '@/routes/focus/desktop'
import { MobileFocus } from '@/routes/focus/mobile'

// The focus route forks by viewport (TECH_PLAN §4.1 / §4.3): desktop (≥768px) vs
// mobile (<768px). M14 owns the DESKTOP branch (focus/desktop.tsx — the two-column
// split: 320px session-strip + main pane with the M13 LiveTerminal, FocusHeader,
// the §4.4.3 DesktopDock, plus document-level keyboard capture). M15 owns the
// MOBILE branch (focus/mobile.tsx — the Vaul drag-detent sheet over the M13
// LiveTerminal, mobile dock, accessory bar, edge gestures). The two branches are
// disjoint files; this is the only fork point they share.
export function Focus() {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  // Desktop (≥768px): M14's split + dock.
  if (isDesktop) return <DesktopFocus />

  // Mobile (<768px): M15's Vaul detent sheet, dock, edge gestures.
  return <MobileFocus />
}
