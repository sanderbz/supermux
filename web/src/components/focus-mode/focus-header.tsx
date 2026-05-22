// FocusHeader (minimal mobile variant) — M15 (TECH_PLAN §4.4 mobile "Top bar":
// 44px + safe-area-top, chevron-back left, session title (truncating) + status
// dot, ··· overflow right). Sentence-case labels, ≥44pt hit targets.

import { motion } from 'framer-motion'
import { ChevronLeft, MoreHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionStatus } from '@/lib/api'
import { StatusDot } from '@/components/session-tile/status-dot'

export interface FocusHeaderProps {
  name: string
  status: SessionStatus
  onBack: () => void
  onOverflow?: () => void
  className?: string
}

export function FocusHeader({
  name,
  status,
  onBack,
  onOverflow,
  className,
}: FocusHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-1',
        className,
      )}
    >
      <motion.button
        type="button"
        aria-label="Back to overview"
        whileTap={{ scale: 0.92 }}
        transition={springs.buttonPress}
        onClick={onBack}
        className="flex size-11 items-center justify-center rounded-lg text-primary active:bg-secondary"
      >
        <ChevronLeft className="size-5" />
      </motion.button>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-1">
        <StatusDot status={status} />
        <h1 className="min-w-0 truncate text-[15px] font-semibold tracking-tight">
          {name}
        </h1>
      </div>

      <motion.button
        type="button"
        aria-label="More"
        whileTap={{ scale: 0.92 }}
        transition={springs.buttonPress}
        onClick={onOverflow}
        className="flex size-11 items-center justify-center rounded-lg text-muted-foreground active:bg-secondary"
      >
        <MoreHorizontal className="size-5" />
      </motion.button>
    </header>
  )
}
