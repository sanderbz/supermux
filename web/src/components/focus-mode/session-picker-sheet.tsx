// SessionPickerSheet — M15 (TECH_PLAN §4.4.1 "Session pill → open session picker
// sheet (full list, selectable)").
//
// A Vaul half-sheet listing every session in the shared pinned-then-active order
// (session-order.ts). Tapping a row switches focus to that session and closes the
// sheet. The current session is marked with an accent rail + check. Glass material
// (regularMaterial), 36×5 drag indicator, ≥44pt rows.

import { Drawer } from 'vaul'
import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { SessionSummary } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { orderSessions } from './session-order'

export interface SessionPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionSummary[]
  current: string
  onPick: (name: string) => void
}

export function SessionPickerSheet({
  open,
  onOpenChange,
  sessions,
  current,
  onPick,
}: SessionPickerSheetProps) {
  const ordered = orderSessions(sessions)

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex max-h-[70vh] flex-col',
            'rounded-t-[10px] border-t border-border/60 pb-safe outline-none',
          )}
        >
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Sessions
          </Drawer.Title>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {ordered.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No other sessions.
              </p>
            ) : (
              ordered.map((s) => {
                const isCurrent = s.name === current
                return (
                  <motion.button
                    key={s.name}
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    transition={springs.buttonPress}
                    onClick={() => {
                      onPick(s.name)
                      onOpenChange(false)
                    }}
                    className={cn(
                      'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left',
                      isCurrent ? 'bg-secondary' : 'active:bg-secondary/60',
                    )}
                  >
                    <StatusDot status={s.status} />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                      {s.name}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {STATUS_LABEL[s.status]}
                    </span>
                    {isCurrent && (
                      <Check className="size-4 shrink-0 text-primary" aria-label="Current" />
                    )}
                  </motion.button>
                )
              })
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
