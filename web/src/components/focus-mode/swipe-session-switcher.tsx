// SwipeSessionSwitcher — feat/swipe-switcher (mobile-only).
//
// A Termius-iPhone-style horizontal session strip that slides up from the
// bottom dock when the user swipes UP from the dock surface. One row of pills
// (status dot + truncated name), `scroll-snap-x` horizontal scroll so more
// sessions are one finger-drag away. Tap a pill → switch to that session.
//
//   ╭ horizontal pills (scroll-x) ─────────────────────────╮
//   │ [● claude-1] [● claude-2] [● router] [● db] [● …]    │   ← sliding bar
//   ╰───────────────────────────────────────────────────────╯
//   ┌ MobileDock (existing) ─────────────────────────────┐
//   │ [✎ Edit] [⌨] [⋯] [＋] [🎙]                  [↵]    │   ← gesture origin
//   └────────────────────────────────────────────────────┘
//
// Mobile-only: this widget assumes the parent has already gated on a
// coarse-pointer / mobile signal. Desktop has the 320px sidebar / focus strip
// which covers the same role — we do NOT duplicate it.
//
// Gesture model (the load-bearing detail):
//
//   • The pointerdown lands on the dock's outer container (the user's natural
//     swipe-up origin). We register a CAPTURE-phase listener so we see the
//     event FIRST without stopping propagation — the dock's buttons still
//     receive it, so a tap on (e.g.) the ⌨ key still flips the keyboard.
//   • We track (x, y, t, pointerId). The gesture is NEVER claimed until
//     finger travel ≥ DRAG_SLOP_PX (8px). Below that it's a tap; we never
//     intercept and the underlying button handles its own click.
//   • If movement crosses the slop AND is predominantly upward (|dy| > |dx|
//     AND dy < 0), we CLAIM the gesture: `setPointerCapture` on our overlay
//     stops subsequent moves/click from reaching the buttons (the press
//     becomes a drag, no button activates on release).
//   • Once claimed, the strip height tracks the finger linearly between 0
//     (closed) and `OPEN_HEIGHT_PX` (fully open). Release at ≥ COMMIT_PX
//     commits to "open"; below that snaps closed.
//   • When OPEN, we ALSO accept downward swipes ON THE STRIP to close, and a
//     tap-outside on the terminal body to close, and the hardware Escape key
//     to close. Tap on a pill → navigate + close.
//
// Reduced motion: the height animation collapses to a 150ms tween.
//
// Accessibility:
//   • When open, the strip is `role="dialog"` `aria-modal="false"`
//     `aria-label="Switch session"` so AT users can identify it.
//   • Each pill is a real <button> with the session name + status as its
//     accessible name. Hit target ≥ 44pt (height + horizontal padding).
//   • Focus is moved to the first non-current pill on open; on close, focus
//     returns to whatever held it before (the dock).
//
// VR battery hooks:
//   • data-vr="swipe-switcher" on the root
//   • data-vr-swipe-state="closed|opening|open"
//   • data-vr-session-name="<name>" + data-vr-current on each entry

import * as React from 'react'
import { motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { ApiSession } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { orderSessions } from '@/components/focus-mode/session-order'

// Threshold knobs (per the feat-swipe-switcher spec):
//   • DRAG_SLOP_PX  — how far the finger must travel before we CLAIM the
//                     gesture. Below this it stays a tap → the dock's button
//                     under the finger gets to handle its own click.
//   • OPEN_HEIGHT   — fully-open bar height: GRABBER_HEIGHT_PX (closed-state
//                     grabber row) + one row of h-11 (44pt) pills + 4px
//                     breathing. Total ≈ 56px. The old 280px value left ~120px
//                     of EMPTY SPACE above + below the single pill row (pills
//                     vertically-centered inside a tall container) — the
//                     "amateur lots of white space" the user complained about.
//   • COMMIT_PX     — vertical travel that commits the swipe-up to "open"
//                     on release; below it the bar snaps back closed.
//   • CLOSE_DRAG_PX — downward travel from OPEN that commits the close.
//   • GRABBER_HEIGHT_PX — closed-state height: just the grabber pill peeking
//                     above the dock as the swipe-up affordance hint. Tap on
//                     it opens the switcher (iOS HIG: tap = swipe alternative).
const DRAG_SLOP_PX = 8
const GRABBER_HEIGHT_PX = 12
const OPEN_HEIGHT_PX = GRABBER_HEIGHT_PX + 44 + 4 // grabber + pill row + tiny pad
const COMMIT_PX = 40 // half-open commits; matches the shorter throw
const CLOSE_DRAG_PX = 30

type SwipeSwitcherState = 'closed' | 'opening' | 'open'

/** `release Δy` (positive = down) → should commit to OPEN. Pulled out of the
 *  effect body so the threshold math reads as one named decision. */
function shouldCommitOpen(travelUpPx: number): boolean {
  return travelUpPx >= COMMIT_PX
}

/** Downward Δy from an OPEN bar → should commit the close. */
function shouldCommitClose(travelDownPx: number): boolean {
  return travelDownPx >= CLOSE_DRAG_PX
}

export interface SwipeSessionSwitcherProps {
  /** All sessions from `useSessions()`. Filtered + ordered inside. */
  sessions: ApiSession[]
  /** Name of the currently-focused session — highlighted as "current". */
  currentName: string
  /** Navigate to a session's focus route. The widget closes after this. */
  onPick: (name: string) => void
  /** The MobileDock element — its `pointerdown` is the gesture origin. We
   *  attach a CAPTURE-phase listener so dock buttons still receive their
   *  taps; only a movement-crossed gesture is intercepted. */
  dockRef: React.RefObject<HTMLDivElement | null>
}

/** Render the swipe-up session switcher. Mounted above MobileDock in the
 *  mobile focus route. Owns its own open-state + gesture handling. */
export function SwipeSessionSwitcher({
  sessions,
  currentName,
  onPick,
  dockRef,
}: SwipeSessionSwitcherProps) {
  const reduceMotion = useReducedMotion()
  const [state, setState] = React.useState<SwipeSwitcherState>('closed')
  const [openOffset, setOpenOffset] = React.useState(0) // px, 0..OPEN_HEIGHT_PX
  // Ref-mirror so the imperative pointer handlers (registered once) read the
  // latest state without re-binding on every render.
  const stateRef = React.useRef<SwipeSwitcherState>('closed')
  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  // Ordered list — reuse the shared `orderSessions` (pinned > live work >
  // recent), the SAME order the overview + edge-swipe nav use. This keeps the
  // "next session" the user expects ALWAYS at the head, which is exactly the
  // Termius quick-switch feel ("the most relevant one is closest to my thumb").
  const ordered = React.useMemo(() => orderSessions(sessions), [sessions])

  // Stable refs for the latest props so the pointer handlers (registered
  // once) read fresh values without re-attaching listeners every render.
  const onPickRef = React.useRef(onPick)
  const currentNameRef = React.useRef(currentName)
  React.useEffect(() => {
    onPickRef.current = onPick
    currentNameRef.current = currentName
  })

  // The DOM element we own — the wrapper that holds the strip. We attach
  // `setPointerCapture` here so once we CLAIM the gesture, subsequent pointer
  // events route to this element (and the dock's buttons stop receiving them,
  // so the in-flight tap won't activate a button on release).
  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  // Focus restore: when the bar opens we move focus to the first non-current
  // pill (hardware-keyboard / a11y users); when it closes we restore focus to
  // whoever owned it before.
  const previousFocusRef = React.useRef<Element | null>(null)
  // First-pill ref (focus target on open).
  const firstPillRef = React.useRef<HTMLButtonElement | null>(null)

  const closeSwitcher = React.useCallback(() => {
    setOpenOffset(0)
    setState('closed')
  }, [])

  // ── Gesture A: SWIPE-UP from the MobileDock to open ────────────────────────
  // Listens for pointerdown on the dock's outer element with a CAPTURE-phase
  // handler (we don't stopPropagation, so dock buttons still receive the
  // event — they handle their own taps). Only crosses the slop threshold and
  // CLAIMS the gesture once the finger has moved ≥ DRAG_SLOP_PX upward; below
  // that it's a tap and we never intercept. Releasing past COMMIT_PX commits
  // open; below it snaps closed.
  //
  // The mirror-image gesture (swipe-down on the OPEN bar) is registered by a
  // second effect attached to the overlay element — they share `stateRef` /
  // `setState` / `closeSwitcher` but never see each other's pointerdowns
  // because the dock and the bar are siblings (capture-phase on dockEl never
  // sees a pointerdown that lands on the bar, and vice-versa). This split
  // keeps each effect focused on one gesture, with no source-multiplexing
  // logic inside the move/up handlers.
  React.useEffect(() => {
    const dockEl = dockRef.current
    if (!dockEl) return

    type Track = {
      id: number
      startX: number
      startY: number
      claimed: boolean
    } | null
    let track: Track = null

    // Block the synthetic click that would otherwise fire after a claimed
    // drag — without this, releasing on top of a dock button would activate
    // it (the iOS soft keyboard would toggle, etc.). One-shot per gesture.
    let swallowNextClick = false
    const onClickCapture = (e: MouseEvent) => {
      if (!swallowNextClick) return
      swallowNextClick = false
      e.stopPropagation()
      e.preventDefault()
    }

    const onPointerDown = (e: PointerEvent) => {
      // Only single-pointer (touch / pen / left-click). Multi-touch (e.g. a
      // pinch on the terminal) → no candidate, never claim.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (track) return // already tracking another finger
      // Only arm while closed — once open the close-gesture (effect B) owns
      // any pointerdown that lands on the bar; the dock taps are then just
      // taps (a tap-outside-the-bar that lands on the dock should NOT close
      // the bar, mirroring how iOS dock buttons keep working with sheets up).
      if (stateRef.current !== 'closed') return

      track = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        claimed: false,
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const dx = e.clientX - track.startX
      const dy = e.clientY - track.startY

      if (!track.claimed) {
        // Slop gate — under the threshold it's still a tap, the original
        // button handles it. Above the threshold we look at WHICH direction
        // dominates: upward swipe = open. Diagonal / horizontal / downward =
        // NOT ours (the user might be initiating a sheet-dismiss drag on
        // Vaul, or a horizontal pan that doesn't belong to us).
        const dist = Math.hypot(dx, dy)
        if (dist < DRAG_SLOP_PX) return
        const vertical = Math.abs(dy) > Math.abs(dx)
        if (!vertical || dy >= 0) return
        // CLAIM: take over the gesture from the dock buttons. setPointerCapture
        // on our overlay so subsequent move/up route here; the dock's
        // pointerup will not see this finger, so its buttons can't fire. Any
        // synthetic click that the browser still queues is swallowed by the
        // click-capture handler above.
        track.claimed = true
        swallowNextClick = true
        try {
          overlayRef.current?.setPointerCapture(e.pointerId)
        } catch {
          // setPointerCapture throws if the target hasn't received any
          // events yet — fine to ignore; we'll still receive moves through
          // the document-level listener.
        }
        setState('opening')
      }

      // Closed-then-opening: -dy is how far up the finger is from start.
      // The bar's resting visual height (closed) is GRABBER_HEIGHT_PX, so we
      // map travel onto (GRABBER, OPEN] — at travel=0 the bar matches its
      // closed height; at travel ≥ (OPEN − GRABBER) it's fully open. Clamped
      // both ends so an over-drag past OPEN doesn't run away.
      const travel = Math.max(0, -dy)
      setOpenOffset(
        Math.min(OPEN_HEIGHT_PX, GRABBER_HEIGHT_PX + travel),
      )
    }

    const onPointerUp = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const claimed = track.claimed
      const dy = e.clientY - track.startY
      track = null
      if (!claimed) return
      if (shouldCommitOpen(-dy)) {
        setOpenOffset(OPEN_HEIGHT_PX)
        setState('open')
      } else {
        closeSwitcher()
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      if (!track || e.pointerId !== track.id) return
      const claimed = track.claimed
      track = null
      if (!claimed) return
      // A cancelled drag (scroll captured, system gesture, app backgrounded)
      // → snap back to closed; never strand the bar mid-height.
      closeSwitcher()
    }

    // CAPTURE-phase on the dock so we see the pointerdown FIRST without
    // stopping propagation. Buttons still receive it; we just observe.
    dockEl.addEventListener('pointerdown', onPointerDown, true)
    // Document-level listeners catch moves even after setPointerCapture
    // redirects to our overlay (PointerEvent capture follows the element
    // chain).
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    dockEl.addEventListener('click', onClickCapture, true)
    return () => {
      dockEl.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      dockEl.removeEventListener('click', onClickCapture, true)
    }
  }, [dockRef, closeSwitcher])

  // ── Gesture B: SWIPE-DOWN on the OPEN bar to close ─────────────────────────
  // Sibling to gesture A. We can't reuse A's listeners because they're
  // attached to the dock (a DOM sibling of the bar) — capture-phase pointer
  // events on the dock never see a pointerdown that lands on the bar. Same
  // slop gate + setPointerCapture model. The horizontally-scrolling pill row
  // is excluded so `overflow-x-auto` keeps its native pan behaviour (a
  // [data-vr-swipe-scroll] sentinel on that child is the explicit exit).
  React.useEffect(() => {
    const bar = overlayRef.current
    if (!bar) return
    type T2 = {
      id: number
      startY: number
      claimed: boolean
    } | null
    let t: T2 = null
    let swallowClick = false

    const onClickCapture = (e: MouseEvent) => {
      if (!swallowClick) return
      swallowClick = false
      e.stopPropagation()
    }

    const onDown = (e: PointerEvent) => {
      if (stateRef.current !== 'open') return
      if (t) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // Don't grab pointerdowns on the horizontally-scrolling pill row — the
      // browser's overflow-x-auto needs them to pan the strip. Only grab on
      // the bar's NON-SCROLLING chrome (the grip + padding around it).
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-vr-swipe-scroll]')) return
      t = {
        id: e.pointerId,
        startY: e.clientY,
        claimed: false,
      }
    }
    const onMove = (e: PointerEvent) => {
      if (!t || e.pointerId !== t.id) return
      const dy = e.clientY - t.startY
      if (!t.claimed) {
        if (dy < DRAG_SLOP_PX) return
        t.claimed = true
        swallowClick = true
        try {
          bar.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setState('opening')
      }
      const travel = Math.max(0, dy)
      setOpenOffset(Math.max(0, OPEN_HEIGHT_PX - travel))
    }
    const onUp = (e: PointerEvent) => {
      if (!t || e.pointerId !== t.id) return
      const claimed = t.claimed
      const dy = e.clientY - t.startY
      t = null
      if (!claimed) return
      if (shouldCommitClose(dy)) closeSwitcher()
      else {
        setOpenOffset(OPEN_HEIGHT_PX)
        setState('open')
      }
    }
    const onCancel = () => {
      t = null
    }

    bar.addEventListener('pointerdown', onDown)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    bar.addEventListener('click', onClickCapture, true)
    return () => {
      bar.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      bar.removeEventListener('click', onClickCapture, true)
    }
  }, [closeSwitcher])

  // ── Tap-outside + Escape to close ──────────────────────────────────────────
  React.useEffect(() => {
    if (state !== 'open') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeSwitcher()
      }
    }
    const onDocPointerDown = (e: PointerEvent) => {
      // Tap outside both the bar AND the dock = dismiss. The dock is included
      // so tapping the keyboard / specials button doesn't ALSO close the bar
      // out from under them (they're the user's continuation of "I'm done
      // browsing sessions, do the next thing").
      const target = e.target as Node | null
      const inBar = !!target && (overlayRef.current?.contains(target) ?? false)
      const inDock = !!target && (dockRef.current?.contains(target) ?? false)
      if (!inBar && !inDock) closeSwitcher()
    }
    document.addEventListener('keydown', onKey)
    // pointerdown (not click) so a tap-outside dismisses BEFORE the synthetic
    // click would fire on whatever the user tapped (terminal etc.).
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDocPointerDown)
    }
  }, [state, closeSwitcher, dockRef])

  // ── Focus management ───────────────────────────────────────────────────────
  React.useEffect(() => {
    if (state === 'open') {
      previousFocusRef.current = document.activeElement
      // Defer to next frame so the pill is mounted + visible before we focus.
      const raf = window.requestAnimationFrame(() => {
        firstPillRef.current?.focus({ preventScroll: true })
      })
      return () => window.cancelAnimationFrame(raf)
    }
    if (state === 'closed') {
      const prev = previousFocusRef.current
      if (prev instanceof HTMLElement) {
        // Skip restore if focus has already moved somewhere meaningful (e.g.
        // the user tapped a different element to close us — restoring would
        // steal that focus). The narrow restore is "if focus is on body" only.
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
      closeSwitcher()
    },
    [closeSwitcher],
  )

  // The switcher is ALWAYS-MOUNTED (the grabber peeks above the dock as the
  // swipe-up affordance hint, iOS-native). One session (no swap targets) hides
  // it entirely; the gesture listeners stay armed but cheap no-ops.
  const firstNonCurrentIdx = React.useMemo(
    () => ordered.findIndex((s) => s.name !== currentName),
    [ordered, currentName],
  )
  const hasSwapTargets = firstNonCurrentIdx !== -1

  // Height: closed → GRABBER_HEIGHT_PX (just the grabber peeking, ~12px);
  // opening → finger-tracked (clamped between GRABBER and OPEN); open →
  // OPEN_HEIGHT_PX. `openOffset` is the absolute pixel height of the bar
  // while opening — gesture A sets it from upward travel, gesture B from
  // (OPEN − downward travel). The grabber stays put at the top of the bar
  // visually because it's positioned `top:0` inside the box.
  let height: number
  if (state === 'closed') height = GRABBER_HEIGHT_PX
  else if (state === 'open') height = OPEN_HEIGHT_PX
  else height = Math.min(OPEN_HEIGHT_PX, Math.max(GRABBER_HEIGHT_PX, openOffset))

  // The pill-row's animated opacity — fades in as the bar opens past the
  // grabber, so finger-tracked it reads as "the pills rising into view."
  const pillsRevealed = state !== 'closed' && height > GRABBER_HEIGHT_PX

  // Tap on the grabber while closed → open the switcher (iOS HIG: tap is the
  // discoverable alternative to swipe-up). Tap while open → close. The height
  // resolves from `state` directly when not 'opening', so we don't need to
  // pre-seed `openOffset` here.
  const onGrabberTap = React.useCallback(() => {
    if (state === 'closed') {
      setState('open')
    } else if (state === 'open') {
      closeSwitcher()
    }
  }, [state, closeSwitcher])
  const onGrabberKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onGrabberTap()
      }
    },
    [onGrabberTap],
  )

  if (!hasSwapTargets) return null

  return (
    <motion.div
      ref={overlayRef}
      data-vr="swipe-switcher"
      data-vr-swipe-state={state}
      role="dialog"
      aria-modal="false"
      aria-label="Switch session"
      animate={{ height }}
      transition={
        reduceMotion
          ? { duration: 0.15 }
          : state === 'opening'
            ? // While the finger is on screen we follow it 1:1 — no
              // smoothing (a spring here would feel laggy).
              { duration: 0 }
            : springs.snippetSlide
      }
      // Visually fuse with the dock — same `glass` background so the open
      // switcher reads as "the dock grew taller upward" (Termius-native), not
      // a second floating bar. The `-mb-px` overlaps the dock's existing
      // border-t so we don't get a double hairline between the two surfaces.
      // The switcher's own `border-t` is the outer top edge of the unified
      // stack (replaces the dock's border as the visible top hairline).
      className={cn(
        'glass relative -mb-px shrink-0 overflow-hidden border-t border-border/60',
        // Touch-pan-x ensures the bar's horizontal scroller still works
        // even while the dock-level pointer logic is observing.
        'touch-pan-x',
      )}
      style={{ height }}
    >
      {/* iOS-style drag handle (grabber). Always visible at the very top of
          the switcher: closed = peeks above the dock as the swipe-up hint;
          open = the close-handle. 36×4 rounded-full muted-gray pill —
          tasteful, not loud. The button stretches full-width across the
          grabber row so any tap above the pills hits the toggle. */}
      <button
        type="button"
        onClick={onGrabberTap}
        onKeyDown={onGrabberKeyDown}
        aria-label="Drag handle — swipe up to switch session"
        aria-expanded={state === 'open'}
        // No focus stealing from xterm's hidden helper textarea (keeps the
        // soft keyboard up if it's already showing, same trick the dock's
        // accessory keys use).
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          // 12px tall full-width row above the pills — the visible 4×36 pill
          // sits at its center. The 390×12 hit area is small in height but
          // generous in width, so reliable to tap on a phone.
          'absolute inset-x-0 top-0 z-10 flex h-3 w-full items-center justify-center',
          'cursor-pointer',
        )}
      >
        <span
          aria-hidden
          data-vr="swipe-grabber"
          className="block h-1 w-9 rounded-full bg-muted-foreground/40"
        />
      </button>

      {/* Pill row — sits below the grabber and meets the dock's top edge with
          a thin breathing band (≤9px) of `glass` background. `pt-3` (12px)
          reserves the absolute-positioned grabber's row at the top; the pill
          itself is h-11 (44pt) and `items-center` keeps it visually centered
          inside the row. Opacity fades in past the grabber peek so the finger-
          tracked drag reads as "pills rising into view." */}
      <motion.div
        data-vr-swipe-scroll
        animate={{ opacity: pillsRevealed ? 1 : 0 }}
        transition={reduceMotion ? { duration: 0.15 } : springs.smooth}
        className={cn(
          'flex h-11 items-center gap-2 overflow-x-auto px-3 pt-3',
          // Native scroll-snap so each pill lands flush — feels closer to
          // Termius's quick-switch (one finger flick = next page of pills).
          'snap-x snap-mandatory',
        )}
        style={{ scrollbarWidth: 'none' }}
      >
        {ordered.map((s, i) => {
          const isCurrent = s.name === currentName
          return (
            <SessionPill
              key={s.name}
              session={s}
              isCurrent={isCurrent}
              onPick={onPickInternal}
              // First non-current pill takes focus on open.
              pillRef={i === firstNonCurrentIdx ? firstPillRef : undefined}
            />
          )
        })}
      </motion.div>
    </motion.div>
  )
}

/** One session pill — status dot + truncated name, ≥44pt hit, snap-aligned. */
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
        // ≥44pt hit target via h-11. Soft pill, continuous corner.
        'flex h-11 shrink-0 snap-start items-center gap-2 rounded-xl px-3 text-[14px] font-medium',
        // Active = the live focused session — primary tint. Otherwise the
        // dock's quiet secondary fill so the strip reads as one rhythm.
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

export default SwipeSessionSwitcher
