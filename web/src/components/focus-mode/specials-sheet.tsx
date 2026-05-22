// SpecialsSheet — M15 (TECH_PLAN §4.4.1 "Specials", §4.4.2 acceptance #5/#6).
//
// A Vaul half-detent sheet (regularMaterial glass) that surfaces every kbd-group
// as a horizontal pager. Each group is a 2×2 grid of four keys; tapping a key
// fires `sendKey(name)` straight at the live pty and closes the sheet, so the
// "specials" path is one tap away without surrendering the keyboard.
//
// Paging uses Framer Motion `drag="x"` with a 40%-width OR velocity>400px/s snap
// threshold, snapping with `springs.snappy` (the ".snappy(duration:0.25)" feel
// from the Termius spec). Page-indicator dots sit beneath the grid and auto-fade
// after 1.5s of stillness. Reduce-Motion swaps the spring for an instant snap.
//
// iOS haptics caveat (§4.4): every chip press scales 0.96→1 (CSS-only visible
// feedback) AND fires navigator.vibrate(8) gated by `'vibrate' in navigator`
// (Android only — a NO-OP on iOS Safari, as documented).

import * as React from 'react'
import { Drawer } from 'vaul'
import { motion, useReducedMotion, type PanInfo } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { KbdGroup } from '@/lib/api'
import { DEFAULT_KBD_GROUPS } from './kbd-groups'

export interface SpecialsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Send a named key to the pty (LiveTerminal.sendKey). */
  onKey: (name: string) => void
  /** Live groups once M16 wires `/api/kbd-groups`; defaults to the seed. */
  groups?: KbdGroup[]
}

export function SpecialsSheet({
  open,
  onOpenChange,
  onKey,
  groups = DEFAULT_KBD_GROUPS,
}: SpecialsSheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[60] bg-black/40" />
        <Drawer.Content
          aria-describedby={undefined}
          className={cn(
            'glass fixed inset-x-0 bottom-0 z-[60] flex flex-col rounded-t-[10px]',
            'border-t border-border/60 pb-safe outline-none',
          )}
        >
          {/* Drag indicator — 36×5, 2.5px radius, tertiary tint (Termius #11). */}
          <div className="mx-auto mt-1.5 h-[5px] w-9 shrink-0 rounded-[2.5px] bg-muted-foreground/30" />
          <Drawer.Title className="px-4 pb-1 pt-3 text-[13px] font-semibold text-muted-foreground">
            Specials
          </Drawer.Title>
          <GroupPager groups={groups} onKey={onKey} onClose={() => onOpenChange(false)} />
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

// ── Horizontal pager of 2×2 key groups ───────────────────────────────────────

function GroupPager({
  groups,
  onKey,
  onClose,
}: {
  groups: KbdGroup[]
  onKey: (name: string) => void
  onClose: () => void
}) {
  const reduceMotion = useReducedMotion()
  const [page, setPage] = React.useState(0)
  const [dotsVisible, setDotsVisible] = React.useState(true)
  const dotsTimer = React.useRef<number | null>(null)
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const [pageW, setPageW] = React.useState(0)

  React.useEffect(() => {
    const measure = () => setPageW(trackRef.current?.clientWidth ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Page indicator auto-fades after 1.5s of stillness (Termius #6). `flashDots`
  // shows the dots and (re)arms the hide timer; the initial show is the default
  // `dotsVisible` state, so the mount effect only needs to schedule the hide.
  const flashDots = React.useCallback(() => {
    setDotsVisible(true)
    if (dotsTimer.current) window.clearTimeout(dotsTimer.current)
    dotsTimer.current = window.setTimeout(() => setDotsVisible(false), 1500)
  }, [])
  React.useEffect(() => {
    // Initial auto-hide — no synchronous setState in the effect body.
    dotsTimer.current = window.setTimeout(() => setDotsVisible(false), 1500)
    return () => {
      if (dotsTimer.current) window.clearTimeout(dotsTimer.current)
    }
  }, [])

  const last = groups.length - 1
  const onDragEnd = (_: unknown, info: PanInfo) => {
    const past =
      Math.abs(info.offset.x) > (pageW || 1) * 0.4 ||
      Math.abs(info.velocity.x) > 400
    let next = page
    if (past) next = info.offset.x < 0 ? Math.min(page + 1, last) : Math.max(page - 1, 0)
    setPage(next)
    flashDots()
  }

  return (
    <div className="px-4 pb-4">
      <div ref={trackRef} className="overflow-hidden">
        <motion.div
          className="flex"
          drag="x"
          dragElastic={0.12}
          dragConstraints={{ left: -pageW * last, right: 0 }}
          animate={{ x: -page * pageW }}
          transition={reduceMotion ? { duration: 0 } : springs.snappy}
          onDragStart={flashDots}
          onDragEnd={onDragEnd}
        >
          {groups.map((g) => (
            <div key={g.id} className="shrink-0 px-0.5" style={{ width: pageW || '100%' }}>
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                {g.name}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {g.keys.slice(0, 4).map((key, i) => (
                  <KeyChip
                    key={`${g.id}-${i}`}
                    label={key}
                    onPress={() => {
                      onKey(key)
                      onClose()
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* Page indicator dots — beneath the grid, auto-fade after 1.5s. */}
      {groups.length > 1 && (
        <motion.div
          aria-hidden
          className="mt-3 flex justify-center gap-1.5"
          animate={{ opacity: dotsVisible ? 1 : 0 }}
          transition={reduceMotion ? { duration: 0 } : springs.smooth}
        >
          {groups.map((g, i) => (
            <span
              key={g.id}
              className={cn(
                'size-1.5 rounded-full transition-colors',
                i === page ? 'bg-foreground' : 'bg-muted-foreground/30',
              )}
            />
          ))}
        </motion.div>
      )}
    </div>
  )
}

function KeyChip({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <motion.button
      type="button"
      // Tap-press scale 0.96 → CSS-only haptic equivalent (§4.4 iOS caveat).
      whileTap={{ scale: 0.96 }}
      transition={springs.buttonPress}
      onClick={() => {
        if ('vibrate' in navigator) navigator.vibrate(8)
        onPress()
      }}
      className={cn(
        // ≥44pt hit target, 8px continuous corner, SF Mono semibold (Termius #5).
        'flex h-12 items-center justify-center rounded-lg border border-border bg-card',
        'font-mono text-[15px] font-semibold text-foreground active:bg-secondary',
      )}
    >
      {label}
    </motion.button>
  )
}
