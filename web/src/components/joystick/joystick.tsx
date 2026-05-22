// joystick.tsx — M17. The Termius "hold-anywhere arrow joystick" + 2-finger
// scrollback gesture, as an absolutely-positioned overlay on the terminal.
//
// TECH_PLAN §4.4 (mobile gestures + iOS haptics caveat), §M17 subagent prompt.
// research/termius-ios-native-spec.md §"Hold-anywhere arrow joystick",
// §"Two-finger PageUp / PageDown", v3 acceptance criteria #2, #3, #4, #7, #13.
//
// THE interaction. Hold ≥350ms anywhere on the terminal → joystick ARMS:
//   • arm haptic — navigator.vibrate(8) (Android) PLUS a 60ms scale 0.96→1.0
//     micro-press on the rose origin (iOS Safari has no navigator.vibrate;
//     §4.4 haptics caveat — documented in web/ACCEPTANCE.md).
//   • a faint translucent "rose" fades in at the touch point: 88px circle,
//     1px tertiary stroke, 0 fill, 80ms ease-in (criterion #3).
//   • drag → radial distance from the press origin picks a SPEED TIER and
//     `sendKey('Up'|'Down'|'Left'|'Right')` repeats at that tier's interval.
//   • direction lock — dominant axis holds through wobble until the touch
//     crosses a 30° re-orient cone for ~80ms (criterion #4).
//   • release → rose fades out 120ms; no haptic.
//
// A SECOND finger landing cancels the joystick and hands off to the 2-finger
// PageUp/PageDown recognizer (use-two-finger.ts).
//
// SURGICAL + ADDITIVE: this is a NEW file. It mounts as a sibling overlay over
// <LiveTerminal/> and drives the SAME `useLiveTerm` handle the dock uses — no
// second WebSocket, no second xterm. Reduce Motion skips the rose; keys still
// flow. Spring physics come from lib/springs.ts; no `transition: all`.

import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { cn } from '@/lib/utils'
import { springs } from '@/lib/springs'
import { useTwoFinger } from '@/components/joystick/use-two-finger'

// ── Tunables (research §"Hold-anywhere arrow joystick") ───────────────────────
const ARM_HOLD_MS = 350 // hold-to-arm threshold (criterion #2: 350ms ± 25ms)
const ARM_CANCEL_PT = 8 // movement > 8pt during the hold cancels into selection
const ROSE_DIAMETER = 88 // px — translucent rose circle (criterion #3)
const DIR_LOCK_PT = 4 // directional travel before the first key fires
const REORIENT_CONE_DEG = 30 // wobble tolerance before the lock re-orients
const REORIENT_HOLD_MS = 80 // sustained re-orient time before the axis flips
// Speed tiers by radial distance from the press origin (repeat interval, ms).
const TIER1_MIN = 8
const TIER2_MIN = 32
const TIER3_MIN = 72
const TIER1_MS = 90 // 8–32pt   → ~11 keys/s (slow)
const TIER2_MS = 50 // 32–72pt  → ~20 keys/s (medium)
const TIER3_MS = 20 // ≥72pt    → ~50 keys/s (fast)

type Dir = 'Up' | 'Down' | 'Left' | 'Right'

export interface JoystickProps {
  /** Emit a named arrow / scrollback key into the pty — the LiveTerminal handle. */
  sendKey(name: string): void
  /** Master on/off — the M16 accessory bar "Gesture" toggle flips this via the
   *  `onGestureToggle` prop. When off the overlay is inert (long-press will
   *  later trigger Apple-style selection — a NEXT-milestone item). */
  enabled?: boolean
  /** Read-only terminals (quick-peek embed) never arm the joystick. */
  readOnly?: boolean
  className?: string
}

/** Radial distance → repeat interval. Distances below TIER1_MIN don't emit. */
function tierInterval(dist: number): number | null {
  if (dist >= TIER3_MIN) return TIER3_MS
  if (dist >= TIER2_MIN) return TIER2_MS
  if (dist >= TIER1_MIN) return TIER1_MS
  return null
}

/** Dominant-axis direction for a delta vector. */
function dirOf(dx: number, dy: number): Dir {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'Right' : 'Left'
  return dy >= 0 ? 'Down' : 'Up'
}

/** Smallest angle (deg) between two direction vectors, 0–180. */
function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  const am = Math.hypot(ax, ay) || 1
  const bm = Math.hypot(bx, by) || 1
  const cos = (ax * bx + ay * by) / (am * bm)
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
}

export function Joystick({
  sendKey,
  enabled = true,
  readOnly = false,
  className,
}: JoystickProps) {
  const reduceMotion = useReducedMotion()
  const active = enabled && !readOnly

  // ── Joystick state ──────────────────────────────────────────────────────────
  // `armed` flips React state so the rose renders; everything time-critical
  // (timers, origin, repeat loop) lives in refs to avoid re-render churn.
  const [armed, setArmed] = React.useState(false)
  const [origin, setOrigin] = React.useState({ x: 0, y: 0 })
  // Micro-press on the rose origin = the iOS-Safari haptic fallback (§4.4).
  const [pressPulse, setPressPulse] = React.useState(false)

  const overlayRef = React.useRef<HTMLDivElement | null>(null)
  const armTimerRef = React.useRef<number | null>(null)
  const repeatTimerRef = React.useRef<number | null>(null)
  const pointerIdRef = React.useRef<number | null>(null)
  const originRef = React.useRef({ x: 0, y: 0 })
  const startRef = React.useRef({ x: 0, y: 0 }) // pre-arm touch point
  const lastPosRef = React.useRef({ x: 0, y: 0 })
  const armedRef = React.useRef(false)
  // Direction lock: current locked axis + the re-orient candidate timer.
  const lockRef = React.useRef<Dir | null>(null)
  const reorientRef = React.useRef<{ dir: Dir; since: number } | null>(null)

  const clearArmTimer = () => {
    if (armTimerRef.current !== null) {
      window.clearTimeout(armTimerRef.current)
      armTimerRef.current = null
    }
  }
  const clearRepeat = () => {
    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
  }

  /** Disarm completely — release OR a second finger landing. */
  const disarm = React.useCallback(() => {
    clearArmTimer()
    clearRepeat()
    armedRef.current = false
    pointerIdRef.current = null
    lockRef.current = null
    reorientRef.current = null
    setArmed(false)
  }, [])

  // `tickRef` lets the setTimeout body call the latest `tick` without the
  // callback referencing itself before it is declared (TDZ).
  const tickRef = React.useRef<() => void>(() => {})

  /** The repeat loop: each tick re-reads distance → tier, re-evaluates the
   *  direction lock, emits one key, and re-schedules at the tier interval. */
  const tick = React.useCallback(() => {
    if (!armedRef.current) return
    const { x, y } = lastPosRef.current
    const dx = x - originRef.current.x
    const dy = y - originRef.current.y
    const dist = Math.hypot(dx, dy)
    const interval = tierInterval(dist)
    if (interval === null) {
      // Inside the dead-zone — keep the loop alive at the slow cadence so the
      // first move past 8pt emits promptly, but send nothing.
      repeatTimerRef.current = window.setTimeout(() => tickRef.current(), TIER1_MS)
      return
    }

    const candidate = dirOf(dx, dy)
    const locked = lockRef.current
    if (locked === null) {
      // First directional travel past the lock threshold → lock the axis.
      if (dist >= DIR_LOCK_PT) {
        lockRef.current = candidate
        reorientRef.current = null
      }
    } else if (candidate !== locked) {
      // Wobble: only re-orient if the touch holds OUTSIDE the 30° cone (relative
      // to the locked axis) for ≥80ms (criterion #4 — lock holds through wobble).
      const lockVec: Record<Dir, [number, number]> = {
        Up: [0, -1],
        Down: [0, 1],
        Left: [-1, 0],
        Right: [1, 0],
      }
      const [lx, ly] = lockVec[locked]
      const off = angleBetween(dx, dy, lx, ly)
      const now = performance.now()
      if (off > REORIENT_CONE_DEG) {
        const ro = reorientRef.current
        if (ro && ro.dir === candidate) {
          if (now - ro.since >= REORIENT_HOLD_MS) {
            lockRef.current = candidate
            reorientRef.current = null
          }
        } else {
          reorientRef.current = { dir: candidate, since: now }
        }
      } else {
        reorientRef.current = null
      }
    } else {
      reorientRef.current = null
    }

    const emit = lockRef.current
    if (emit) sendKey(emit)
    repeatTimerRef.current = window.setTimeout(() => tickRef.current(), interval)
  }, [sendKey])

  // Keep `tickRef` pointed at the latest `tick` so timers always run current logic.
  React.useEffect(() => {
    tickRef.current = tick
  }, [tick])

  /** Arm the joystick — fired by the 350ms hold timer. */
  const arm = React.useCallback(() => {
    armedRef.current = true
    setArmed(true)
    originRef.current = { ...startRef.current }
    setOrigin({ ...startRef.current })
    lockRef.current = null
    reorientRef.current = null

    // Arm feedback. (a) Android Chrome haptic; (b) iOS Safari fallback = a
    // 60ms scale 0.96→1.0 micro-press on the rose (no navigator.vibrate on iOS).
    if ('vibrate' in navigator) navigator.vibrate(8)
    if (!reduceMotion) {
      setPressPulse(true)
      window.setTimeout(() => setPressPulse(false), 60)
    }

    // Kick the repeat loop — it sits in the dead-zone until the touch moves.
    clearRepeat()
    repeatTimerRef.current = window.setTimeout(() => tickRef.current(), TIER1_MS)
  }, [reduceMotion])

  // ── Two-finger PageUp/Down recognizer — shares this overlay ─────────────────
  // A second pointer landing cancels the joystick (research §"Conflict").
  const twoFinger = useTwoFinger({
    sendKey,
    onTwoFingerStart: disarm,
    enabled: active,
  })

  // ── Pointer handlers on the overlay ─────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    twoFinger.onPointerDown(e)
    if (!active) return
    // Only the FIRST pointer arms the joystick; a 2nd is the scrollback gesture.
    if (pointerIdRef.current !== null) {
      // Second finger — bail out of any pending arm + active joystick.
      disarm()
      return
    }
    pointerIdRef.current = e.pointerId
    startRef.current = { x: e.clientX, y: e.clientY }
    lastPosRef.current = { x: e.clientX, y: e.clientY }
    // Start the 350ms hold-to-arm timer. Movement > 8pt before it fires cancels.
    clearArmTimer()
    armTimerRef.current = window.setTimeout(arm, ARM_HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    twoFinger.onPointerMove(e)
    if (!active) return
    if (e.pointerId !== pointerIdRef.current) return
    lastPosRef.current = { x: e.clientX, y: e.clientY }

    if (!armedRef.current) {
      // Pre-arm: a >8pt move cancels into normal selection (criterion #2).
      const dx = e.clientX - startRef.current.x
      const dy = e.clientY - startRef.current.y
      if (Math.hypot(dx, dy) > ARM_CANCEL_PT) {
        clearArmTimer()
        pointerIdRef.current = null
      }
    }
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    twoFinger.onPointerUp(e)
    if (e.pointerId === pointerIdRef.current) disarm()
  }

  // Cleanup on unmount — never leave a repeat timer running.
  React.useEffect(() => disarm, [disarm])
  // If the joystick gets disabled mid-gesture, tear it down on the next frame
  // (deferred so we never setState synchronously inside the effect body).
  React.useEffect(() => {
    if (active) return
    const id = window.requestAnimationFrame(() => disarm())
    return () => window.cancelAnimationFrame(id)
  }, [active, disarm])

  return (
    <div
      ref={overlayRef}
      // Absolute overlay covering the terminal viewport. `touch-none` so the
      // browser doesn't claim the gesture for native scroll/selection. When
      // disabled it's pointer-events-none so taps reach xterm beneath.
      className={cn(
        'absolute inset-0 z-20',
        active ? 'touch-none' : 'pointer-events-none',
        className,
      )}
      data-armed={armed ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      aria-hidden
    >
      {/* The rose — translucent 88px ring at the press origin. Reduce Motion
          skips it entirely (criterion #13); keys still flow. */}
      <AnimatePresence>
        {armed && !reduceMotion && (
          <motion.div
            key="joystick-rose"
            // 80ms ease-in fade-in (criterion #3); 120ms ease-out fade-out.
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{
              opacity: 1,
              // The 60ms micro-press doubles as the iOS-Safari arm haptic.
              scale: pressPulse ? 0.96 : 1,
            }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={
              pressPulse
                ? { duration: 0.06, ease: 'easeOut' }
                : springs.snappy
            }
            style={{
              left: origin.x - ROSE_DIAMETER / 2,
              top: origin.y - ROSE_DIAMETER / 2,
              width: ROSE_DIAMETER,
              height: ROSE_DIAMETER,
            }}
            className="pointer-events-none fixed rounded-full border border-border/70 bg-transparent"
          >
            {/* A faint centre dot marks the origin / dead-zone. */}
            <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default Joystick
