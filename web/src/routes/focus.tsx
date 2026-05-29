import { useMediaQuery } from '@/hooks/use-media-query'
import { DesktopFocus } from '@/routes/focus/desktop'
import { MobileFocus } from '@/routes/focus/mobile'

// The focus route forks by viewport: desktop (≥768px) vs
// mobile (<768px). The DESKTOP branch (focus/desktop.tsx) is the two-column
// split: 320px session-strip + main pane with the LiveTerminal, FocusHeader,
// the DesktopDock, plus document-level keyboard capture. The
// MOBILE branch (focus/mobile.tsx) is the Vaul drag-detent sheet over the
// LiveTerminal, mobile dock, accessory bar, edge gestures. The two branches are
// disjoint files; this is the only fork point they share.
export function Focus() {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  // Desktop (≥768px): split + dock.
  if (isDesktop) return <DesktopFocus />

  // Mobile (<768px): Vaul detent sheet, dock, edge gestures.
  return <MobileFocus />
}
