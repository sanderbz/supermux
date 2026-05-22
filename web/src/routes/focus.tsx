import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { motion } from 'framer-motion'

import { LiveTerminal } from '@/components/terminal/live-terminal'
import { springs } from '@/lib/springs'

// M13: the focus route now mounts the REAL live terminal against the M4 WS pty
// stream. The full focus mode — desktop split + dock (M14), mobile Vaul sheet +
// edge gestures (M15), joystick (M17) — wraps this in later milestones. This is
// the load-bearing terminal surface they build around.

export function Focus() {
  const { name = '' } = useParams()
  const navigate = useNavigate()

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Minimal focus header (44px) — iOS-native, Title-Case. The full header
          with status dot + Detach/Stop arrives in M14/M15. */}
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
