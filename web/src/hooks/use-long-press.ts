// useLongPress — press-and-hold detector (350ms).
//
// Powers the mobile tile's long-press → quick-peek. Cancels if the pointer
// drifts past `moveTolerance`px so it never fires mid-scroll. A short press
// that never crossed the hold threshold fires `onClick` (= tap → focus) on
// pointer-up instead.

import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

export interface LongPressOptions {
  onLongPress: () => void
  onClick?: () => void
  /** Hold duration before long-press fires. Default 350ms. */
  ms?: number
  /** Drift (px) that cancels the press — treats it as a scroll. */
  moveTolerance?: number
}

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

export function useLongPress({
  onLongPress,
  onClick,
  ms = 350,
  moveTolerance = 8,
}: LongPressOptions): LongPressHandlers {
  const timer = useRef<number | null>(null)
  const firedRef = useRef(false)
  const movedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      firedRef.current = false
      movedRef.current = false
      startRef.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = window.setTimeout(() => {
        firedRef.current = true
        onLongPress()
      }, ms)
    },
    [clear, ms, onLongPress],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (movedRef.current) return
      const dx = e.clientX - startRef.current.x
      const dy = e.clientY - startRef.current.y
      if (Math.hypot(dx, dy) > moveTolerance) {
        movedRef.current = true
        clear()
      }
    },
    [clear, moveTolerance],
  )

  const onPointerUp = useCallback(() => {
    clear()
    if (!firedRef.current && !movedRef.current) onClick?.()
  }, [clear, onClick])

  const onPointerLeave = useCallback(() => clear(), [clear])
  const onPointerCancel = useCallback(() => clear(), [clear])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
  }
}
