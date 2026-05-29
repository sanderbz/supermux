// EnableToggle — the per-schedule enable/disable switch. Spring-physics
// thumb (springs.toggleSnap) with an optimistic flip; on error it reverts and
// reports. ≥44pt hit target. Used in both the list row and the detail header.

import * as React from 'react'
import { motion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { usePatchSchedule } from '@/hooks/use-scheduler'

interface EnableToggleProps {
  id: string
  enabled: boolean
  onError?: (message: string) => void
}

export function EnableToggle({ id, enabled, onError }: EnableToggleProps) {
  const patch = usePatchSchedule()
  // Optimistic local mirror so the thumb moves the instant it's tapped, while
  // re-syncing to the prop when the server-confirmed value changes (the
  // store-during-render pattern — no setState-in-effect).
  const [on, setOn] = React.useState(enabled)
  const [lastProp, setLastProp] = React.useState(enabled)
  if (enabled !== lastProp) {
    setLastProp(enabled)
    setOn(enabled)
  }

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !on
    setOn(next)
    patch.mutate(
      { id, patch: { enabled: next } },
      {
        onError: (err) => {
          setOn(!next) // revert
          onError?.(`Couldn’t ${next ? 'enable' : 'disable'} — ${(err as Error).message}`)
        },
      },
    )
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Disable schedule' : 'Enable schedule'}
      onClick={toggle}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors',
        // ≥44pt tap target via padding box without inflating the visual switch.
        'before:absolute before:-inset-2.5 before:content-[""]',
        on ? 'bg-primary' : 'bg-muted',
      )}
    >
      <motion.span
        layout
        transition={springs.toggleSnap}
        className={cn(
          'block size-6 rounded-full bg-white shadow-sm',
          on ? 'ml-auto' : 'ml-0',
        )}
      />
    </button>
  )
}
