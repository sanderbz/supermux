// useEdgeGestures — M15 edge-swipe navigation (TECH_PLAN §4.4 "Edge-swipe
// gestures", user-vision.md "Gestures").
//
//   • Edge-swipe-RIGHT (from the LEFT edge, ≥40px inward, velocity ≥800 px/s)
//     → back to overview.
//   • Edge-swipe-LEFT  (from the RIGHT edge)
//     → next session in pinned-then-active order.
//
// While a left-edge drag is in progress we expose a live `peekX` motion value and
// the `nextSession` it would land on, so the route can render a peek-of-next
// (title + status dot) that tracks the finger and springs back if released before
// the 40%-width threshold (it commits the navigate if past it).
//
// Implementation: a single set of pointer listeners on `document.body`. We only
// arm when the pointerdown lands within EDGE_PX of a screen edge, so normal
// terminal scrolling / Vaul sheet drags are never hijacked. Reduce-Motion is
// honoured by the consumer (the peek render), not here — the gesture itself is an
// intent, not a decoration.

import * as React from 'react'
import {
  useMotionValue,
  type MotionValue,
} from 'framer-motion'

import type { ApiSession } from '@/lib/api'

const EDGE_PX = 16 // start zone width at each screen edge
const COMMIT_DX = 40 // min horizontal travel to count as a swipe
const COMMIT_VELOCITY = 800 // px/s threshold (Termius edge-swipe spec)
const COMMIT_FRACTION = 0.4 // …OR ≥40% of viewport width

export interface EdgeGestureState {
  /** Live horizontal offset of the in-progress LEFT-edge drag (0 when idle). */
  peekX: MotionValue<number>
  /** The session a committed LEFT-edge swipe would switch to (peek-of-next). */
  nextSession: ApiSession | null
  /** True while a left-edge drag is active (route renders the peek-of-next). */
  dragging: boolean
}

export interface EdgeGestureOptions {
  /** Right-edge swipe (Δx leftwards) target — typically the next session. */
  onSwipeLeft: () => void
  /** Left-edge swipe (Δx rightwards) target — typically back to overview. */
  onSwipeRight: () => void
  /** Resolve the "next session" for the left-edge peek preview (no commit). */
  resolveNext: () => ApiSession | null
  /** Disable while a sheet/picker is dragging so gestures don't double-fire. */
  enabled?: boolean
}

export function useEdgeGestures({
  onSwipeLeft,
  onSwipeRight,
  resolveNext,
  enabled = true,
}: EdgeGestureOptions): EdgeGestureState {
  const peekX = useMotionValue(0)
  const [nextSession, setNextSession] = React.useState<ApiSession | null>(
    null,
  )
  const [dragging, setDragging] = React.useState(false)

  // Latest callbacks via ref so the listener effect never re-binds (and so a
  // re-render mid-gesture can't tear the tracking down). Updated in an effect —
  // never during render — so the ref write doesn't fight React's render phase.
  const cb = React.useRef({ onSwipeLeft, onSwipeRight, resolveNext, enabled })
  React.useEffect(() => {
    cb.current = { onSwipeLeft, onSwipeRight, resolveNext, enabled }
  })

  React.useEffect(() => {
    type Track = {
      id: number
      edge: 'left' | 'right'
      startX: number
      lastX: number
      lastT: number
      velocity: number
    } | null
    let track: Track = null

    const onDown = (e: PointerEvent) => {
      if (!cb.current.enabled) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const w = window.innerWidth
      const fromLeft = e.clientX <= EDGE_PX
      const fromRight = e.clientX >= w - EDGE_PX
      if (!fromLeft && !fromRight) return
      track = {
        id: e.pointerId,
        edge: fromLeft ? 'left' : 'right',
        startX: e.clientX,
        lastX: e.clientX,
        lastT: e.timeStamp,
        velocity: 0,
      }
      if (fromLeft) {
        // Begin the peek-of-next (left edge drags the current view rightwards
        // to reveal the next session beneath).
        setNextSession(cb.current.resolveNext())
        setDragging(true)
        peekX.set(0)
      }
    }

    const onMove = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const dt = Math.max(1, e.timeStamp - track.lastT)
      track.velocity = ((e.clientX - track.lastX) / dt) * 1000 // px/s
      track.lastX = e.clientX
      track.lastT = e.timeStamp
      if (track.edge === 'left') {
        // Only track rightward travel; clamp so the view never drags off-screen.
        const dx = Math.max(0, Math.min(e.clientX - track.startX, window.innerWidth))
        peekX.set(dx)
      }
    }

    const finish = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const dx = e.clientX - track.startX
      const w = window.innerWidth
      const speed = Math.abs(track.velocity)
      const past =
        Math.abs(dx) >= COMMIT_DX &&
        (speed >= COMMIT_VELOCITY || Math.abs(dx) >= w * COMMIT_FRACTION)
      const edge = track.edge
      track = null
      if (edge === 'left') {
        setDragging(false)
        if (past && dx > 0) {
          cb.current.onSwipeRight() // left edge swiped inwards → overview
        } else {
          // Spring the peek back; the route's <motion.div> animates peekX → 0.
          peekX.set(0)
          setNextSession(null)
        }
      } else if (past && dx < 0) {
        cb.current.onSwipeLeft() // right edge swiped inwards → next session
      }
    }

    document.body.addEventListener('pointerdown', onDown, { passive: true })
    document.body.addEventListener('pointermove', onMove, { passive: true })
    document.body.addEventListener('pointerup', finish, { passive: true })
    document.body.addEventListener('pointercancel', finish, { passive: true })
    return () => {
      document.body.removeEventListener('pointerdown', onDown)
      document.body.removeEventListener('pointermove', onMove)
      document.body.removeEventListener('pointerup', finish)
      document.body.removeEventListener('pointercancel', finish)
    }
  }, [peekX])

  return { peekX, nextSession, dragging }
}
