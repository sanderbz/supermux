import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { motion } from 'framer-motion'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { DesktopFocus } from '@/routes/focus/desktop'

// M14: the focus route now forks by breakpoint. At ≥768px it mounts the full
// DESKTOP focus mode — the two-column split (320px session-strip + main pane
// with the M13 LiveTerminal, FocusHeader, the §4.4.3 DesktopDock) plus the
// document-level keyboard capture (⌘K/⌘D/⌘W/⌘1..9; all other keys flow to
// xterm). Below 768px it keeps the minimal M13 mobile surface — the full mobile
// Vaul sheet + edge gestures land in M15.

export function Focus() {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  if (isDesktop) {
    return <DesktopFocus />
  }

  return <MobileFocusFallback />
}

/** Minimal mobile surface (M13 baseline). M15 replaces this with the Vaul sheet,
 *  mobile dock, accessory bar, and edge gestures. */
function MobileFocusFallback() {
  const { name = '' } = useParams()
  const navigate = useNavigate()

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2 pt-safe">
        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          transition={springs.buttonPress}
          onClick={() => navigate('/')}
          aria-label="Back to overview"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-primary"
        >
          <ChevronLeft className="size-5" />
        </motion.button>
        <h1 className="truncate text-sm font-semibold tracking-tight">{name}</h1>
      </header>

      <div className="min-h-0 flex-1">
        <LiveTerminal name={name} />
      </div>
    </div>
  )
}
