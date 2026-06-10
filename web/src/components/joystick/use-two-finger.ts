// use-two-finger — two-finger PageUp/PageDown recognizer over the terminal.
//
// Tracks two SIMULTANEOUS pointers inside the terminal viewport, averages their
// vertical translation, and emits scrollback keys:
//   • two-finger swipe DOWN ≥ 20pt cumulative → PageUp  (reveal history)
//   • two-finger swipe UP   ≥ 20pt cumulative → PageDown
//   • every additional 24pt of translation → one more PageUp/Down
//   • velocity > 1500 px/s → emit 2 keys at once (instant page-of-page)
//
// Crossing the 20pt threshold fires within 100ms; the gesture
// never false-fires during a one-finger joystick — the joystick subscribes to
// the SAME `onTwoFingerStart` callback so it cancels the moment a 2nd pointer
// lands. WebSocket-only: the keys go out via `sendKey` from the LiveTerminal
// `useLiveTerm` handle — no polling, no extra socket.

import * as React from 'react'

// ── Tunables ──────────────────────────────────────────────────────────────────
const FIRST_EMIT_PT = 20 // cumulative dominant-axis translation before 1st emit
const REPEAT_PT = 24 // every additional 24pt → one more key
const VELOCITY_FAST = 1500 // px/s → emit 2 keys at once

export interface TwoFingerHandlers {
  /** Attach to the terminal viewport element. */
  onPointerDown(e: React.PointerEvent): void
  onPointerMove(e: React.PointerEvent): void
  onPointerUp(e: React.PointerEvent): void
}

export interface UseTwoFingerOpts {
  /** Emit a named scrollback key (PageUp / PageDown) into the pty. */
  sendKey(name: string): void
  /** Fired the instant a SECOND pointer lands — the joystick uses this to
   *  cancel its one-finger gesture (research §"Conflict"). */
  onTwoFingerStart?(): void
  /** Disable entirely (e.g. read-only embeds). */
  enabled?: boolean
}

interface PointerSample {
  id: number
  y: number
}

/** Two-finger scrollback recognizer. Returns pointer handlers to spread onto the
 *  terminal viewport overlay. */
export function useTwoFinger({
  sendKey,
  onTwoFingerStart,
  enabled = true,
}: UseTwoFingerOpts): TwoFingerHandlers {
  // Live pointers currently down on the surface (id → last sample).
  const pointersRef = React.useRef<Map<number, PointerSample>>(new Map())
  // Average Y at the moment the 2nd finger landed (gesture origin).
  const originYRef = React.useRef(0)
  // Number of keys already emitted this gesture (for the 24pt repeat ladder).
  const emittedRef = React.useRef(0)
  // Whether the 2-finger gesture is active (exactly 2 pointers).
  const activeRef = React.useRef(false)
  // Velocity tracking — last sample for px/s estimate.
  const lastYRef = React.useRef(0)
  const lastTRef = React.useRef(0)

  const avgY = React.useCallback(() => {
    const ps = pointersRef.current
    let sum = 0
    for (const p of ps.values()) sum += p.y
    return ps.size ? sum / ps.size : 0
  }, [])

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return
      pointersRef.current.set(e.pointerId, { id: e.pointerId, y: e.clientY })
      // The SECOND simultaneous pointer arms the recognizer.
      if (pointersRef.current.size === 2) {
        activeRef.current = true
        emittedRef.current = 0
        originYRef.current = avgY()
        lastYRef.current = originYRef.current
        lastTRef.current = performance.now()
        // Cancel any in-flight one-finger joystick the instant we go 2-up.
        onTwoFingerStart?.()
      }
    },
    [enabled, avgY, onTwoFingerStart],
  )

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || !activeRef.current) return
      const tracked = pointersRef.current.get(e.pointerId)
      if (!tracked) return
      tracked.y = e.clientY
      if (pointersRef.current.size !== 2) return

      const now = performance.now()
      const y = avgY()
      // dy > 0 → fingers moved DOWN (PageUp); dy < 0 → UP (PageDown).
      const dy = y - originYRef.current
      const dist = Math.abs(dy)
      if (dist < FIRST_EMIT_PT) return

      // How many keys SHOULD have fired by now: 1 at 20pt, then +1 per 24pt.
      const wanted = 1 + Math.floor((dist - FIRST_EMIT_PT) / REPEAT_PT)
      if (wanted <= emittedRef.current) {
        lastYRef.current = y
        lastTRef.current = now
        return
      }

      // Velocity (px/s) over the last move — fast flicks emit doubles.
      const dt = Math.max(now - lastTRef.current, 1)
      const velocity = (Math.abs(y - lastYRef.current) / dt) * 1000
      const key = dy > 0 ? 'PageUp' : 'PageDown'

      let pending = wanted - emittedRef.current
      // Velocity short-cut: a single fast tick emits an extra key (criterion
      // §"Velocity short-cut") — capped so a stutter can't dump a screenful.
      if (velocity > VELOCITY_FAST) pending = Math.min(pending + 1, 3)

      for (let i = 0; i < pending; i++) sendKey(key)
      emittedRef.current = wanted
      lastYRef.current = y
      lastTRef.current = now
    },
    [enabled, avgY, sendKey],
  )

  const endPointer = React.useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    // Dropping below 2 pointers ends the gesture; a fresh 2-up re-arms it.
    if (pointersRef.current.size < 2) {
      activeRef.current = false
      emittedRef.current = 0
    }
  }, [])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endPointer,
  }
}
