// MobileBottomPanel — the unified mobile bottom surface (polish/swipe-integrate).
//
// One panel = ONE positioned element that holds BOTH the session-pills strip
// AND the existing MobileDock (Edit/⌨/···/+/🎙/↵). The pills row sits ABOVE the
// dock content; on swipe-up the whole panel "grows" upward to reveal the pills,
// pushing the terminal's flex-1 area up by exactly the pills row height. On
// swipe-down (or tap-on-grabber while open), the panel shrinks back to dock-only.
//
// This replaces the previous architecture (a separate `SwipeSessionSwitcher`
// rendered as a SIBLING above MobileDock). Two siblings with their own borders,
// backgrounds and animated heights compete for the bottom anchor → visible
// "glackiness" (the user's word). One container, one height/transform driver,
// one continuous surface → smooth.
//
//   ╭─ panel (single bg-card / glass surface, ONE top border) ───────────────╮
//   │ ─ grabber (4×36 pill) ─                                                │
//   │ ╭─ pills row (h:44, overflow-x-auto, NO vertical scroll) ─────────────╮│
//   │ │ [● claude-1] [● claude-2] [● router] [● db] [● …]                   ││
//   │ ╰─────────────────────────────────────────────────────────────────────╯│
//   │ ─ MobileDock content (unchanged) ──────────────────────────────────────│
//   │ [✎ Edit] [⌨] [···] [＋] [🎙]                              [↵ Enter]    │
//   ╰────────────────────────────────────────────────────────────────────────╯
//
// Geometry:
//   • The panel always lives in flex flow at the bottom of MobileSheet. Its
//     OUTER height is animated between H_DOCK (closed) and H_DOCK + H_PILLS
//     (open). The terminal's `flex-1 min-h-0` re-flows around it — exactly ONE
//     element changes size each frame, so there's no two-sibling thrash.
//   • The panel has `overflow: hidden` so the pills row (which sits at the TOP
//     of the column) is clipped off-screen when the panel is at its closed
//     height. There is no second border, no opacity gate, no separate layer —
//     just a clipped child of the single growing wrapper.
//   • The grabber is positioned `absolute; top:0`; it's visible above the pills
//     row when open (as a drag-to-close handle) and inside the dock's tiny
//     top-strip when closed (peeking ~12px above as the swipe-up affordance).
//
// Gesture model (relocated, not rewritten — the prior critic confirmed this is
// correct; we just bind it to the panel wrapper instead of the dock sibling):
//   • Capture-phase pointerdown on the PANEL WRAPPER (covers both pills and
//     dock surfaces): swipes started ANYWHERE on the panel are claimable; taps
//     on the dock's buttons still receive the event because we don't
//     stopPropagation.
//   • 8 px upward movement (closed) or downward (open) crosses the slop +
//     claims the gesture; `setPointerCapture` on the wrapper.
//   • Capture-phase click swallow after a claimed drag: a swipe that releases
//     on a dock button never triggers the button.
//   • Multi-touch rejection (`pointerType` + `e.button` checks).
//   • A/B arming: swipe-UP claims only while closed; swipe-DOWN claims only
//     while open. Inside the pills row, native horizontal scroll keeps working
//     because `data-vr-swipe-scroll` is the exclusion sentinel for the close
//     gesture (the open-gesture is only armed when state === 'closed' anyway).
//   • `useReducedMotion` collapses the spring to a 150 ms tween.
//
// Pills row CSS — the scrollbar fix:
//   • `flex h-[44px] shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden`
//   • Every pill is `shrink-0` so the row never compresses pills into a multi-
//     line cluster that could overflow vertically.
//   • The scrollbar is visually hidden (`[scrollbar-width:none]` +
//     `[&::-webkit-scrollbar]:hidden`) so the row reads as a clean strip.
//   • No `pt-*` or `min-h-*` larger than the row's natural height — the prior
//     `pt-3` inside an `h-11` row was what made scrollHeight (50) > clientHeight
//     (44) and gave Chrome a reason to promote the perpendicular axis to
//     `overflow-y: auto`.

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { ApiSession } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { orderSessions } from '@/components/focus-mode/session-order'

// ── Geometry knobs ────────────────────────────────────────────────────────────
//   • PILLS_ROW_HEIGHT_PX — fixed-height of the pills strip. 44 = iOS hit target;
//     matches each pill's own h-11 so the row hugs the pill content with no
//     vertical padding (the scrollbar fix lives here).
//   • DRAG_SLOP_PX — minimum finger travel before we claim the gesture; below
//     this it stays a tap → the dock's button under the finger handles its own
//     click.
//   • COMMIT_OPEN_PX / COMMIT_CLOSE_PX — vertical travel that commits to the
//     new state on release; below it snaps back.
const PILLS_ROW_HEIGHT_PX = 44
const DRAG_SLOP_PX = 8
const COMMIT_OPEN_PX = 24
const COMMIT_CLOSE_PX = 24

type PanelState = 'closed' | 'dragging' | 'open'

export interface MobileBottomPanelProps {
  /** All sessions from `useSessions()`. Filtered + ordered inside (pinned >
   *  live > recent). When there is only one session the pills row is hidden
   *  (no swap targets) but the gesture listeners stay armed as cheap no-ops. */
  sessions: ApiSession[]
  /** Name of the currently-focused session — highlighted as "current". */
  currentName: string
  /** Navigate to a session's focus route. The panel closes after this. */
  onPick: (name: string) => void
  /** The dock content — rendered inside the panel at the BOTTOM of the column.
   *  We pass it as a child so MobileBottomPanel doesn't need to know about the
   *  dock's many props (the route knows them, and renders <MobileDock> directly
   *  as children). */
  children: React.ReactNode
}

/** The unified mobile bottom panel — pills row + dock as one continuous
 *  surface, with a single gesture-driven reveal. */
export function MobileBottomPanel({
  sessions,
  currentName,
  onPick,
  children,
}: MobileBottomPanelProps) {
  const reduceMotion = useReducedMotion()
  const [state, setState] = React.useState<PanelState>('closed')
  // While dragging we follow the finger 1:1: `dragOffset` is the 0..PILLS_ROW_HEIGHT_PX
  // pixels the panel has "grown" above its closed height. At rest = 0 (closed)
  // or PILLS_ROW_HEIGHT_PX (open).
  const [dragOffset, setDragOffset] = React.useState(0)

  // Ref-mirror for the imperative pointer handlers (registered once) so they
  // read the latest state without re-binding every render.
  const stateRef = React.useRef<PanelState>('closed')
  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  // Ordered sessions — shared with the overview/edge-swipe nav (pinned > live
  // > recent).
  const ordered = React.useMemo(() => orderSessions(sessions), [sessions])
  const firstNonCurrentIdx = React.useMemo(
    () => ordered.findIndex((s) => s.name !== currentName),
    [ordered, currentName],
  )
  const hasSwapTargets = firstNonCurrentIdx !== -1

  // Latest-onPick ref so the gesture closure doesn't re-bind on every render.
  const onPickRef = React.useRef(onPick)
  React.useEffect(() => {
    onPickRef.current = onPick
  })

  // The DOM element that owns the gesture: the panel wrapper. setPointerCapture
  // routes subsequent move/up here once we CLAIM, so the dock's pointerup never
  // sees the finger (its buttons can't fire on release after a claimed drag).
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  // Focus restore on close — and the first non-current pill takes focus on open.
  const previousFocusRef = React.useRef<Element | null>(null)
  const firstPillRef = React.useRef<HTMLButtonElement | null>(null)

  const closePanel = React.useCallback(() => {
    setDragOffset(0)
    setState('closed')
  }, [])
  const openPanel = React.useCallback(() => {
    setDragOffset(PILLS_ROW_HEIGHT_PX)
    setState('open')
  }, [])

  // ── Gesture: swipe-up (closed → open) AND swipe-down (open → closed) ───────
  // ONE listener block on the wrapper, since both gestures share the same
  // plumbing (slop gate + setPointerCapture + click swallow). The direction
  // arming is gated by `stateRef.current`: when closed, only swipe-UP claims;
  // when open, only swipe-DOWN claims. Inside the pills row, horizontal native
  // scroll keeps working because `data-vr-swipe-scroll` is excluded from the
  // close gesture and the open gesture only fires when the panel is closed
  // (pills row is then hidden anyway).
  React.useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    type Track = {
      id: number
      startX: number
      startY: number
      direction: 'up' | 'down' // arming direction at pointerdown
      claimed: boolean
    } | null
    let track: Track = null

    // Block the synthetic click that the browser fires after a claimed drag —
    // without this, releasing on top of a dock button would activate it
    // (toggle the keyboard, send Enter, etc.). Reset per gesture.
    let swallowNextClick = false
    const onClickCapture = (e: MouseEvent) => {
      if (!swallowNextClick) return
      swallowNextClick = false
      e.stopPropagation()
      e.preventDefault()
    }

    const onPointerDown = (e: PointerEvent) => {
      // Single-pointer only — multi-touch (e.g. a pinch on the terminal) →
      // never a candidate.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (track) return // already tracking another finger
      // Direction arming: closed → swipe-UP opens; open → swipe-DOWN closes.
      // 'dragging' is a transient state during the gesture — never armed from.
      const s = stateRef.current
      if (s !== 'closed' && s !== 'open') return
      // While OPEN we exclude pointerdowns on the horizontally-scrolling pill
      // row so native overflow-x panning keeps working; the gesture is then
      // only claimable from the dock surface.
      if (s === 'open') {
        const target = e.target as HTMLElement | null
        if (target?.closest('[data-vr-swipe-scroll]')) return
      }
      track = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        direction: s === 'closed' ? 'up' : 'down',
        claimed: false,
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const dx = e.clientX - track.startX
      const dy = e.clientY - track.startY

      if (!track.claimed) {
        const dist = Math.hypot(dx, dy)
        if (dist < DRAG_SLOP_PX) return
        // Predominantly vertical movement in the armed direction → claim.
        // Diagonal / horizontal / wrong-direction → never ours.
        const vertical = Math.abs(dy) > Math.abs(dx)
        if (!vertical) return
        if (track.direction === 'up' && dy >= 0) return
        if (track.direction === 'down' && dy <= 0) return

        track.claimed = true
        swallowNextClick = true
        try {
          wrapper.setPointerCapture(e.pointerId)
        } catch {
          /* setPointerCapture can throw if the target hasn't received any
             events yet — fine; we still receive moves via document-level
             listeners below. */
        }
        setState('dragging')
      }

      // Linear 1:1 finger tracking between 0 (closed) and PILLS_ROW_HEIGHT_PX
      // (open). Opening: -dy is upward travel; closing: PILLS_ROW_HEIGHT_PX − dy.
      const travel =
        track.direction === 'up'
          ? Math.max(0, -dy)
          : Math.max(0, PILLS_ROW_HEIGHT_PX - dy)
      setDragOffset(Math.min(PILLS_ROW_HEIGHT_PX, travel))
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const claimed = track.claimed
      const dy = e.clientY - track.startY
      const direction = track.direction
      track = null
      if (!claimed) return
      if (direction === 'up') {
        if (-dy >= COMMIT_OPEN_PX) openPanel()
        else closePanel()
      } else {
        if (dy >= COMMIT_CLOSE_PX) closePanel()
        else openPanel()
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const claimed = track.claimed
      track = null
      if (!claimed) return
      // A cancelled drag (system gesture, app backgrounded) → snap back to the
      // ARMED-FROM state. Never strand the panel mid-height.
      if (stateRef.current === 'dragging') {
        // We were dragging from `direction`'s armed state; snap back to that.
        // For up-armed (was closed) → close; for down-armed (was open) → open.
        // Reading the direction off the closure here would be lost since
        // `track` was nulled; instead use the post-cancel snap rule: any
        // cancel returns to the LAST committed state, which we held in
        // stateRef before transitioning to 'dragging' — but we set 'dragging'
        // in onPointerMove without snapshotting. Safest: snap to the closest
        // detent based on current dragOffset.
        setDragOffset((cur) => {
          if (cur >= PILLS_ROW_HEIGHT_PX / 2) {
            setState('open')
            return PILLS_ROW_HEIGHT_PX
          }
          setState('closed')
          return 0
        })
      }
    }

    // CAPTURE-phase so we see the pointerdown FIRST without stopping
    // propagation; the dock's buttons still receive their taps.
    wrapper.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    wrapper.addEventListener('click', onClickCapture, true)
    return () => {
      wrapper.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      wrapper.removeEventListener('click', onClickCapture, true)
    }
  }, [closePanel, openPanel])

  // ── Tap-outside + Escape to close ──────────────────────────────────────────
  React.useEffect(() => {
    if (state !== 'open') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closePanel()
      }
    }
    const onDocPointerDown = (e: PointerEvent) => {
      // Tap inside the panel keeps it open; tap outside dismisses. We use
      // pointerdown so a tap-outside that lands on the terminal dismisses
      // BEFORE the synthetic click fires there.
      const target = e.target as Node | null
      const inside = !!target && (wrapperRef.current?.contains(target) ?? false)
      if (!inside) closePanel()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDocPointerDown)
    }
  }, [state, closePanel])

  // ── Focus management ───────────────────────────────────────────────────────
  React.useEffect(() => {
    if (state === 'open') {
      previousFocusRef.current = document.activeElement
      const raf = window.requestAnimationFrame(() => {
        firstPillRef.current?.focus({ preventScroll: true })
      })
      return () => window.cancelAnimationFrame(raf)
    }
    if (state === 'closed') {
      const prev = previousFocusRef.current
      if (prev instanceof HTMLElement) {
        // Only restore if focus is on body (nothing else has grabbed it).
        if (document.activeElement === document.body) {
          prev.focus({ preventScroll: true })
        }
      }
      previousFocusRef.current = null
    }
  }, [state])

  const onPickInternal = React.useCallback(
    (name: string) => {
      onPickRef.current(name)
      closePanel()
    },
    [closePanel],
  )

  // Tap on the grabber: closed → open, open → close (iOS HIG: tap is the
  // discoverable alternative to swipe).
  const onGrabberTap = React.useCallback(() => {
    if (state === 'closed') openPanel()
    else if (state === 'open') closePanel()
  }, [state, openPanel, closePanel])
  const onGrabberKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onGrabberTap()
      }
    },
    [onGrabberTap],
  )

  // Pills row reveal height: 0 (closed) ‥ PILLS_ROW_HEIGHT_PX (open). The
  // wrapper's flex height = dockHeight + revealHeight; with overflow:hidden the
  // top pills row is clipped exactly to the revealed portion. One value drives
  // everything — no second opacity gate, no second layer.
  let revealHeight: number
  if (state === 'closed') revealHeight = 0
  else if (state === 'open') revealHeight = PILLS_ROW_HEIGHT_PX
  else revealHeight = Math.max(0, Math.min(PILLS_ROW_HEIGHT_PX, dragOffset))

  return (
    <motion.div
      ref={wrapperRef}
      data-vr="mobile-bottom-panel"
      data-vr-swipe-state={state}
      // The continuous surface — pills + dock share ONE glass background, ONE
      // top hairline, ONE 10px continuous-corner rounding at the top edge of the
      // sheet. No mid-panel border, no doubled outline.
      className={cn(
        'glass relative shrink-0 overflow-hidden border-t border-border/60',
        // Touch-pan-x keeps the inner horizontal scroll working while our
        // capture-phase pointer listener observes — vertical claims are explicit.
        'touch-pan-x',
      )}
    >
      {/* Pills row — fixed height (44 px) inside an overflow-x-only strip.
          When the panel is closed, this child is clipped off the top by the
          parent's `overflow: hidden` because the parent's first row in the
          column is sized via the animated `revealHeight` wrapper just below.

          Vertical scrollbar fix: `h-[44px]`, `overflow-x-auto overflow-y-hidden`,
          every pill `shrink-0` — the row's natural content never exceeds 44 px
          tall, so the browser has no reason to promote `overflow-y` to `auto`.
          Scrollbar visually hidden via `[scrollbar-width:none]` +
          `[&::-webkit-scrollbar]:hidden`. */}
      {hasSwapTargets && (
        <motion.div
          animate={{ height: revealHeight }}
          transition={
            reduceMotion
              ? { duration: 0.15 }
              : state === 'dragging'
                ? // While the finger is on screen we follow it 1:1 — no
                  // smoothing (a spring here would feel laggy).
                  { duration: 0 }
                : springs.snippetSlide
          }
          // The growable mask: this inner wrapper's height animates between 0
          // and PILLS_ROW_HEIGHT_PX; overflow:hidden on the outer panel clips
          // the pills row off the top edge of the panel exactly as the mask
          // narrows. ONE element, ONE animated value drives the whole reveal.
          className="overflow-hidden"
          // `inert` (not aria-hidden): blurs focus AND hides from AT, so a
          // pill that briefly retained focus during an open→close transition
          // never leaves us in the "aria-hidden on a focused element" warning
          // state. Modern browsers (Chrome 102+ / Safari 15.5+) honor inert
          // natively; React 19 maps the JSX boolean to the right DOM attribute.
          inert={state === 'closed'}
        >
          <div
            data-vr-swipe-scroll
            role="listbox"
            aria-label="Switch session"
            className={cn(
              'flex h-[44px] shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden px-3',
              // Native scroll-snap so a finger flick lands a pill flush — feels
              // closer to Termius's quick-switch.
              'snap-x snap-mandatory',
              // Hide the scrollbar visually — both engines.
              '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            )}
          >
            {ordered.map((s, i) => {
              const isCurrent = s.name === currentName
              return (
                <SessionPill
                  key={s.name}
                  session={s}
                  isCurrent={isCurrent}
                  onPick={onPickInternal}
                  pillRef={i === firstNonCurrentIdx ? firstPillRef : undefined}
                  // Tab order is handled by the parent's `inert` attribute when
                  // closed — pills are removed from the focusable set wholesale.
                />
              )
            })}
          </div>
        </motion.div>
      )}

      {/* The grabber — iOS-style horizontal handle (4×36 muted pill) sitting at
          the very top of the dock content. When closed it peeks ~6 px above
          the dock surface as the swipe-up affordance; when open it's the
          drag-to-close handle. Full-width 12 px tall button for a generous tap
          target. preventDefault on pointer/mouse-down so the tap never steals
          focus from xterm's hidden helper textarea (the SAME trick the dock's
          accessory keys use — keeps the soft keyboard up). */}
      {hasSwapTargets && (
        <button
          type="button"
          onClick={onGrabberTap}
          onKeyDown={onGrabberKeyDown}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Drag handle — swipe up to switch session"
          aria-expanded={state === 'open'}
          className={cn(
            'flex h-3 w-full items-center justify-center',
            'cursor-pointer',
          )}
        >
          <span
            aria-hidden
            data-vr="swipe-grabber"
            className="block h-1 w-9 rounded-full bg-muted-foreground/40"
          />
        </button>
      )}

      {/* Dock content — exactly what the route already renders today. We let
          the route compose <MobileDock> directly so MobileBottomPanel doesn't
          have to know the dock's many props (and stays a pure presentational
          shell that owns ONE thing: the panel chrome + the reveal gesture). */}
      {children}
    </motion.div>
  )
}

/** One session pill — status dot + truncated name, ≥44pt hit, snap-aligned.
 *  Identical look + behaviour to the pre-refactor SessionPill; relocated here
 *  so the strip and the pill are one cohesive surface in code. */
function SessionPill({
  session,
  isCurrent,
  onPick,
  pillRef,
}: {
  session: ApiSession
  isCurrent: boolean
  onPick: (name: string) => void
  pillRef?: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <motion.button
      ref={pillRef}
      type="button"
      data-vr-session-name={session.name}
      data-vr-current={isCurrent || undefined}
      whileTap={{ scale: 0.94 }}
      transition={springs.buttonPress}
      onClick={() => onPick(session.name)}
      aria-label={`Switch to ${session.name} — ${STATUS_LABEL[session.status]}${
        isCurrent ? ' (current)' : ''
      }`}
      aria-current={isCurrent || undefined}
      className={cn(
        // ≥44pt hit target via h-11. Soft pill, continuous corner. shrink-0 so
        // a long list never compresses pills into a vertically-overflowing
        // cluster (the original bug).
        'flex h-11 shrink-0 snap-start items-center gap-2 rounded-xl px-3 text-[14px] font-medium',
        isCurrent
          ? 'bg-primary/15 text-primary'
          : 'bg-secondary text-secondary-foreground active:bg-secondary/70',
      )}
    >
      <StatusDot status={session.status} />
      <span className="max-w-[160px] truncate">{session.name}</span>
    </motion.button>
  )
}

export default MobileBottomPanel
