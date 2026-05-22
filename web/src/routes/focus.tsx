import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { motion } from 'framer-motion'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { springs } from '@/lib/springs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { MobileFocus } from '@/routes/focus/mobile'

// The focus route forks by viewport (TECH_PLAN §4.1 / §4.3): desktop (≥768px) vs
// mobile (<768px). M15 owns the MOBILE branch — the Vaul drag-detent sheet over
// the M13 LiveTerminal (focus/mobile.tsx). M14 owns the DESKTOP branch
// (focus/desktop.tsx — split + dock); on merge, swap the desktop fallback below
// for `<DesktopFocus />`. The two branches are disjoint files so the parallel
// M14/M15 agents never edit each other's code (only this fork point overlaps).

export function Focus() {
  const isDesktop = useMediaQuery('(min-width: 768px)')

  // Mobile (<768px): the M15 hero — Vaul detent sheet, dock, edge gestures.
  if (!isDesktop) return <MobileFocus />

  // Desktop (≥768px): M14's <DesktopFocus /> replaces this minimal fallback.
  return <DesktopFocusFallback />
}

function DesktopFocusFallback() {
  const { name = '' } = useParams()
  const navigate = useNavigate()
  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Minimal focus header (44px). The full desktop split + dock arrives in
          M14 (focus/desktop.tsx). */}
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
