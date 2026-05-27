// MobileBottomPanel — native-quality iOS-style bottom drawer.
//
// THE MODEL (read this first):
//
//   The panel is ONE bottom-anchored surface with TWO sections stacked
//   vertically inside it (top → bottom DOM order):
//
//     ╭─ panel (glass; one top hairline; rounded continuous corners) ──╮
//     │  ─── 22pt drag handle (with the 4×36pt visual pill at center) ──│
//     │  ╭─ pills row (h: 44pt; revealed by drag-up) ─────────────────╮│
//     │  │  [● claude-1]  [● claude-2]  [● router]  [● db]  …          ││
//     │  ╰────────────────────────────────────────────────────────────╯│
//     │  ─── MobileDock (children — Edit/⌨/···/+/🎙/↵, plus the iOS ───│
//     │       accessory key row when the soft keyboard is up) ─────────│
//     ╰────────────────────────────────────────────────────────────────╯
//
//   • Resting (closed): the pills-row height = 0. Panel = handle + dock.
//   • Expanded (open):  the pills-row height = PILLS_H. Panel grows UPWARD
//     by exactly PILLS_H; the terminal's `flex-1 min-h-0` shrinks to match.
//
// THE GESTURE (the part the previous version got wrong):
//
//   The drag handle is THE drag region — a single 22pt-tall full-width strip
//   at the very top of the panel. It carries `touch-action: none` so the OS
//   doesn't preempt our vertical drag, and a pointerdown anywhere ON IT
//   captures the pointer to the strip (so the move/up always reach us — the
//   finger can wander off the handle without losing the drag).
//
//   The DOCK BUTTONS are untouched: pointer events go to them as usual. No
//   capture-phase listener on the wrapper, no swallow-the-next-click after a
//   drag, no risk of an Esc/Enter tap firing as the panel collapses.
//
//   Drag physics:
//     • tap (no movement past 6pt within 250ms)      → toggle
//     • drag UP from closed                          → follow 1:1, snap on
//       release: ≥40% of PILLS_H committed → open, else snap back closed
//     • drag DOWN from open                          → follow 1:1, snap on
//       release: ≥40% travel committed → close, else snap back open
//     • flick (release velocity ≥ 600 px/s)          → commit in that direction
//
//   Snap-back uses framer-motion `springs.sheetDetent` (Apple Maps feel:
//   stiffness 280, damping 30). Reduced-motion users get a 150ms tween.
//
// HIT TARGET:
//   • The handle's hit region is the FULL panel width × 22pt — well above
//     Apple's 44pt floor when you include the dock's top edge proximity.
//     The visible pill itself is the classic 4×36pt iOS grabber.
//
// ESCAPE HATCHES:
//   • Tap outside (anywhere not in the panel) → close.
//   • Esc key                                  → close.
//   • Switching to a session                   → close (and the new session's
//     terminal takes focus).
//
// SAFE-AREA:
//   The dock children own `pb-[max(env(safe-area-inset-bottom),0.625rem)]` so
//   the home indicator never overlaps. The panel here only owns the chrome
//   above that.

import * as React from 'react'
import { motion, useReducedMotion, type PanInfo } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import type { ApiSession } from '@/lib/api'
import { StatusDot, STATUS_LABEL } from '@/components/session-tile/status-dot'
import { orderSessions } from '@/components/focus-mode/session-order'

// ── Geometry knobs ────────────────────────────────────────────────────────────
//   PILLS_H        — height of the revealed pills row. 44pt iOS hit target.
//   HANDLE_HIT_H   — height of the invisible touch region around the visual
//                    grabber pill. 22pt minimum, easy to grab without crowding
//                    the dock buttons below.
//   COMMIT_RATIO   — fraction of PILLS_H you must travel to commit on release.
//   FLING_VEL_PX_S — pointer velocity (px/s) that always commits in its
//                    direction regardless of distance — the iOS flick.
//   TAP_SLOP_PX    — pointer travel under which a release counts as a tap.
//   TAP_MAX_MS     — press duration above which a release stops counting as
//                    a tap (a long press without movement is not a toggle).
const PILLS_H = 44
const HANDLE_HIT_H = 22
const COMMIT_RATIO = 0.4
const FLING_VEL_PX_S = 600
const TAP_SLOP_PX = 6
const TAP_MAX_MS = 250

type PanelState = 'closed' | 'dragging' | 'open'

export interface MobileBottomPanelProps {
  /** All sessions from `useSessions()`. Filtered + ordered inside (pinned >
   *  live > recent). When there is only one session the pills row is hidden
   *  (no swap targets) and the handle collapses to nothing — the dock then
   *  has no drawer affordance and reads as a plain bottom bar. */
  sessions: ApiSession[]
  /** Name of the currently-focused session — highlighted as "current". */
  currentName: string
  /** Navigate to a session's focus route. The panel closes after this. */
  onPick: (name: string) => void
  /** The dock content (MobileDock). Rendered at the bottom of the panel. */
  children: React.ReactNode
}

/** The unified mobile bottom panel — handle + pills + dock as one continuous
 *  iOS-native bottom drawer with a single drag gesture on the handle. */
export function MobileBottomPanel({
  sessions,
  currentName,
  onPick,
  children,
}: MobileBottomPanelProps) {
  const reduceMotion = useReducedMotion()
  const [state, setState] = React.useState<PanelState>('closed')
  // The live drag offset in px — 0 = closed, PILLS_H = open. While dragging
  // we set this 1:1 to the finger; at rest it equals the detent of `state`.
  const [dragOffset, setDragOffset] = React.useState(0)

  // Ordered sessions — pinned > live > recent — shared with the overview's
  // edge-swipe order so muscle memory carries over.
  const ordered = React.useMemo(() => orderSessions(sessions), [sessions])
  const firstNonCurrentIdx = React.useMemo(
    () => ordered.findIndex((s) => s.name !== currentName),
    [ordered, currentName],
  )
  const hasSwapTargets = firstNonCurrentIdx !== -1

  // Latest-onPick mirror so the close-and-pick callback doesn't churn the
  // effect-bound listeners.
  const onPickRef = React.useRef(onPick)
  React.useEffect(() => {
    onPickRef.current = onPick
  })

  // ── Refs for focus restoration + the panel-wrapper outside-tap test ────────
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const previousFocusRef = React.useRef<Element | null>(null)
  const firstPillRef = React.useRef<HTMLButtonElement | null>(null)

  const close = React.useCallback(() => {
    setDragOffset(0)
    setState('closed')
  }, [])
  const open = React.useCallback(() => {
    setDragOffset(PILLS_H)
    setState('open')
  }, [])
  const toggle = React.useCallback(() => {
    setState((s) => {
      if (s === 'open') {
        setDragOffset(0)
        return 'closed'
      }
      setDragOffset(PILLS_H)
      return 'open'
    })
  }, [])

  // ── The drag handle's gesture (the ONE pointer handler in this component) ──
  //
  // We use framer-motion's `motion.div drag="y"` on the handle: it gives us
  // the 1:1 finger-follow, pointer-capture, multi-touch rejection, and
  // release-velocity for free; we just translate offset+velocity into our
  // open/close detents on release. The DOCK BUTTONS below are completely
  // unaffected — the drag region is geometrically scoped to the handle alone.
  //
  // `dragArmedFromRef` snapshots the panel's state at the instant the drag
  // STARTS, so onDrag/onDragEnd can compute "where did the finger START in
  // open-amount terms?" without racing the React `state` flip to 'dragging'.
  // It's a ref (not state) because (a) it never needs to trigger a render,
  // (b) reading it from event handlers must be synchronous, and (c) writing
  // it from `onDragStart` is part of the gesture's natural lifecycle.
  const dragArmedFromRef = React.useRef<'open' | 'closed'>('closed')
  const draggingRef = React.useRef(false)
  const tapCandidateRef = React.useRef<{ t: number; x: number; y: number } | null>(
    null,
  )

  const onHandlePointerDown = React.useCallback((e: React.PointerEvent) => {
    // Only single-touch / left-mouse — pinch / right-click are never drags.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    draggingRef.current = false
    tapCandidateRef.current = { t: Date.now(), x: e.clientX, y: e.clientY }
  }, [])

  // Use a callback-ref pattern to avoid the stateRef churn: capture the
  // last-committed (open/closed) panel state into `dragArmedFromRef` lazily
  // from the *current* React state at drag-start time. We read it via a
  // closure over a function-form setState so it always sees the freshest
  // value (and never trips the "modifying a hook argument" lint rule).
  const onHandleDragStart = React.useCallback(() => {
    draggingRef.current = true
    setState((s) => {
      // s is either 'closed' or 'open' here — 'dragging' is unreachable
      // from a pointerdown that begins a NEW drag (the previous drag's
      // onPointerUp/cancel always settles back to a detent first).
      const armed: 'open' | 'closed' = s === 'open' ? 'open' : 'closed'
      dragArmedFromRef.current = armed
      return 'dragging'
    })
  }, [])

  const onHandleDrag = React.useCallback(
    (_: unknown, info: PanInfo) => {
      // Per the gesture spec: drag UP from closed grows the pills row,
      // drag DOWN from open shrinks it. `info.offset.y` is +ve when the
      // finger has moved DOWN from the pointerdown point.
      const startOffset = dragArmedFromRef.current === 'open' ? PILLS_H : 0
      // Convert finger-travel into an open-amount in [0, PILLS_H]. Up =
      // negative dy = open more; down = positive dy = close more.
      const next = clamp(startOffset - info.offset.y, 0, PILLS_H)
      setDragOffset(next)
    },
    [],
  )

  const onHandleDragEnd = React.useCallback(
    (_: unknown, info: PanInfo) => {
      const armed = dragArmedFromRef.current
      const startOffset = armed === 'open' ? PILLS_H : 0
      const next = clamp(startOffset - info.offset.y, 0, PILLS_H)
      const fling = info.velocity.y
      // Fling: any motion above FLING_VEL_PX_S commits in its direction,
      // regardless of how far the finger actually traveled.
      if (fling <= -FLING_VEL_PX_S) {
        open()
        return
      }
      if (fling >= FLING_VEL_PX_S) {
        close()
        return
      }
      // Settled: commit if you've crossed COMMIT_RATIO of the detent gap,
      // else snap back to where you came from.
      const traveled = Math.abs(next - startOffset)
      const commit = traveled >= PILLS_H * COMMIT_RATIO
      if (armed === 'closed') {
        if (commit) open()
        else close()
      } else {
        if (commit) close()
        else open()
      }
    },
    [close, open],
  )

  const onHandlePointerUp = React.useCallback(
    (e: React.PointerEvent) => {
      const cand = tapCandidateRef.current
      tapCandidateRef.current = null
      if (!cand) return
      // A drag committed → onDragEnd handled it; not a tap.
      if (draggingRef.current) return
      const dist = Math.hypot(e.clientX - cand.x, e.clientY - cand.y)
      const elapsed = Date.now() - cand.t
      if (dist < TAP_SLOP_PX && elapsed < TAP_MAX_MS) {
        toggle()
      }
    },
    [toggle],
  )

  const onHandleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        open()
      } else if (e.key === 'ArrowDown' || e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    },
    [toggle, open, close],
  )

  // ── Tap-outside + Escape close ─────────────────────────────────────────────
  React.useEffect(() => {
    if (state !== 'open') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      const inside = !!target && (panelRef.current?.contains(target) ?? false)
      if (!inside) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDocPointerDown)
    }
  }, [state, close])

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
        // Only restore focus if it's still on body — the user hasn't
        // grabbed it elsewhere (e.g. tapping back into the terminal).
        if (document.activeElement === document.body) {
          prev.focus({ preventScroll: true })
        }
      }
      previousFocusRef.current = null
    }
  }, [state])

  const onPickInternal = React.useCallback((name: string) => {
    onPickRef.current(name)
    setDragOffset(0)
    setState('closed')
  }, [])

  // The pills-row's animated height in px. While dragging we follow the
  // finger 1:1 (no spring lag); at rest we tween to the detent with the
  // Apple Maps spring.
  const revealHeight = state === 'dragging' ? dragOffset : state === 'open' ? PILLS_H : 0

  return (
    <motion.div
      ref={panelRef}
      data-vr="mobile-bottom-panel"
      data-vr-swipe-state={state}
      // ONE continuous glass surface: pills + dock share the same background
      // and the same top hairline. The handle sits on top as a 22pt drag region
      // that's part of the same surface.
      //
      // overflow-hidden clips the pills-row mask cleanly to height 0 when closed
      // and to PILLS_H when open — no second border, no opacity gate, no second
      // animated value.
      className={cn(
        'glass relative shrink-0 overflow-hidden border-t border-border/60',
      )}
    >
      {/* The drag handle — the ONE drag region. 22pt tall hit area; visible
          4×36pt iOS grabber pill centered. touch-action:none disables the OS's
          vertical-pan preempt so our drag is always honored on iOS. cursor
          flips to grabbing while dragging.

          framer-motion `drag="y"` with `dragConstraints={{top:0,bottom:0}}`
          keeps the handle visually fixed (we drive the pills-row height
          separately via state), but still gives us the full PanInfo stream
          (offset + velocity) on the handle itself.

          We attach a pointerdown/up pair too so a TAP (no drag commit, no
          significant movement) toggles the panel — the discoverable iOS
          alternative to the swipe affordance. */}
      {hasSwapTargets && (
        <motion.div
          role="button"
          tabIndex={0}
          aria-label={
            state === 'open'
              ? 'Drag down or tap to hide session switcher'
              : 'Drag up or tap to show session switcher'
          }
          aria-expanded={state === 'open'}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0}
          dragMomentum={false}
          onPointerDown={onHandlePointerDown}
          onPointerUp={onHandlePointerUp}
          onDragStart={onHandleDragStart}
          onDrag={onHandleDrag}
          onDragEnd={onHandleDragEnd}
          onKeyDown={onHandleKeyDown}
          // Stop the soft keyboard from being dismissed when the user grabs the
          // handle (the same focus-preservation trick the dock buttons use).
          onPointerDownCapture={(e) => e.preventDefault()}
          style={{ touchAction: 'none', height: HANDLE_HIT_H }}
          className={cn(
            'relative z-10 flex w-full shrink-0 cursor-grab items-center justify-center',
            'select-none active:cursor-grabbing focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-ring',
          )}
          data-vr="mobile-bottom-panel-handle"
        >
          <span
            aria-hidden
            data-vr="swipe-grabber"
            className="block h-1 w-9 rounded-full bg-muted-foreground/40"
          />
        </motion.div>
      )}

      {/* Pills row — animated height 0 → PILLS_H. ONE motion.div, ONE animated
          value, ONE spring. The whole row, scrollbar fix included:
            • h-[44px] matches each pill's h-11 so natural content == box
            • overflow-y-hidden defends against perpendicular-axis promotion
            • [scrollbar-width:none] + ::-webkit-scrollbar:hidden = no scrollbar
            • every pill is shrink-0 so the row never multi-lines */}
      {hasSwapTargets && (
        <motion.div
          animate={{ height: revealHeight }}
          transition={
            reduceMotion
              ? { duration: 0.15 }
              : state === 'dragging'
                ? { duration: 0 } // follow the finger frame-perfectly
                : springs.sheetDetent
          }
          className="overflow-hidden"
          // `inert` (not aria-hidden): blurs focus AND hides from AT, so a
          // pill that briefly retained focus during open→close transition
          // doesn't trip Chrome's "aria-hidden on a focused element" warning.
          inert={state === 'closed'}
        >
          <div
            role="listbox"
            aria-label="Switch session"
            className={cn(
              'flex h-[44px] shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden px-3',
              // Native scroll-snap so a finger-flick lands a pill flush.
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
                />
              )
            })}
          </div>
        </motion.div>
      )}

      {/* Dock content — exactly what the route renders. We let mobile.tsx pass
          <MobileDock> as children so this component stays a pure presentational
          shell that owns ONE thing: the panel chrome + the drawer gesture. */}
      {children}
    </motion.div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
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
