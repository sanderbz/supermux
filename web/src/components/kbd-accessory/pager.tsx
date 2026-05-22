// M16 — <Pager />: horizontal snap-swipe between kbd-groups.
//
// research/termius-ios-native-spec.md §"Swipeable 4-key accessory groups":
//   • Horizontal swipe across the function-key zone pages to next/prev group.
//   • Page break at translation > 30 % of group width OR velocity > 400 pt/s.
//   • Snap spring `.snappy(duration: 0.25)` → `springs.snappy`.
//   • Page-indicator dots (6×6 pt) appear beneath the group for 1.5 s after a
//     page change, then auto-fade (§"page indicator dots ... for 1.5 s").
//
// Built on Framer Motion `<motion.div drag="x" dragConstraints>` per the M16
// subagent prompt. Reduce-Motion swaps the snap spring for an instant set.
// The pager only owns paging; key presses are delegated to <Group /> chips.

import * as React from 'react'
import { motion, useReducedMotion, type PanInfo } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { KbdGroup } from '@/lib/api'
import { Group } from './group'

export function Pager({
  groups,
  onKey,
}: {
  groups: KbdGroup[]
  onKey: (name: string) => void
}) {
  const reduceMotion = useReducedMotion()
  const [rawPage, setRawPage] = React.useState(0)
  const [pageW, setPageW] = React.useState(0)
  const trackRef = React.useRef<HTMLDivElement | null>(null)

  // Measure the viewport so the drag track + snap math use real pixels.
  React.useEffect(() => {
    const measure = () => setPageW(trackRef.current?.clientWidth ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Derive the active page clamped to the current list length — a manage-sheet
  // remove can shrink `groups` below `rawPage`; clamping at render (not via a
  // setState-in-effect) keeps the pager valid without a cascading render.
  const lastIdx = Math.max(groups.length - 1, 0)
  const page = Math.min(rawPage, lastIdx)
  const setPage = setRawPage

  // Page-indicator dots: visible for 1.5 s after any page change, then fade.
  const [dotsVisible, setDotsVisible] = React.useState(true)
  const dotsTimer = React.useRef<number | null>(null)
  const flashDots = React.useCallback(() => {
    setDotsVisible(true)
    if (dotsTimer.current) window.clearTimeout(dotsTimer.current)
    dotsTimer.current = window.setTimeout(() => setDotsVisible(false), 1500)
  }, [])
  React.useEffect(() => {
    // Initial auto-hide — scheduled, never a synchronous setState in the body.
    dotsTimer.current = window.setTimeout(() => setDotsVisible(false), 1500)
    return () => {
      if (dotsTimer.current) window.clearTimeout(dotsTimer.current)
    }
  }, [])

  const onDragEnd = (_: unknown, info: PanInfo) => {
    // Snap threshold: 30 % of group width OR velocity > 400 pt/s (§spec).
    const past =
      Math.abs(info.offset.x) > (pageW || 1) * 0.3 ||
      Math.abs(info.velocity.x) > 400
    let next = page
    if (past) {
      next =
        info.offset.x < 0
          ? Math.min(page + 1, lastIdx)
          : Math.max(page - 1, 0)
    }
    setPage(next)
    flashDots()
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div ref={trackRef} className="overflow-hidden">
        <motion.div
          className="flex"
          drag={groups.length > 1 ? 'x' : false}
          dragElastic={0.12}
          dragConstraints={{ left: -pageW * lastIdx, right: 0 }}
          animate={{ x: -page * pageW }}
          transition={reduceMotion ? { duration: 0 } : springs.snappy}
          onDragStart={flashDots}
          onDragEnd={onDragEnd}
        >
          {groups.map((g) => (
            <div
              key={g.id}
              className="shrink-0"
              style={{ width: pageW || '100%' }}
            >
              <Group group={g} onKey={onKey} />
            </div>
          ))}
        </motion.div>
      </div>

      {/* Page-indicator dots — beneath the group, auto-fade after 1.5 s. */}
      {groups.length > 1 && (
        <motion.div
          aria-hidden
          className="flex justify-center gap-1 pb-0.5"
          animate={{ opacity: dotsVisible ? 1 : 0 }}
          transition={reduceMotion ? { duration: 0 } : springs.smooth}
        >
          {groups.map((g, i) => (
            <span
              key={g.id}
              className={cn(
                // 6×6 pt dots — active = label tint, rest = tertiary.
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
