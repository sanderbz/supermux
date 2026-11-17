// The divider between the roster rail and the detail pane, as a drag handle.
//
// A `role="separator"` with a value, so it is one control for every input:
// pointer drag (mouse, pen and touch alike — pointer capture keeps the drag
// alive when the finger leaves the 20px strip), arrow keys, Home/End, and a
// double-click or Enter to go back to the default width.
//
// While dragging, the width is written straight to the rail's `--gr-rail-w`
// custom property, so a drag re-renders nothing; the store is written once, on
// release. What gets stored is the rail's MEASURED width, not the pointer's
// position: the CSS clamps the rail so the pane keeps its minimum, and storing
// the unclamped number would make the next drag start from a width nobody sees.

import * as React from 'react'

import {
  RAIL_DEFAULT_W,
  RAIL_MAX_W,
  RAIL_MIN_W,
  clampRailWidth,
  useRailWidthStore,
} from '@/stores/rail-width-store'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64

export function RailResizeHandle({
  railRef,
}: {
  railRef: React.RefObject<HTMLDivElement | null>
}) {
  const stored = useRailWidthStore((s) => s.width)
  const setWidth = useRailWidthStore((s) => s.setWidth)
  const drag = React.useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  // The width on screen, for `aria-valuenow`: observed, not derived, because
  // the clamp (and a window resize) can show less than the stored value.
  const [shown, setShown] = React.useState(stored ?? RAIL_DEFAULT_W)

  React.useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setShown(Math.round(entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width))
    })
    ro.observe(rail)
    return () => ro.disconnect()
  }, [railRef])

  const measure = () => railRef.current?.getBoundingClientRect().width ?? stored ?? RAIL_DEFAULT_W
  const commit = (px: number | null) => setWidth(px)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, w: measure() }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !railRef.current) return
    const px = clampRailWidth(drag.current.w + e.clientX - drag.current.x)
    railRef.current.style.setProperty('--gr-rail-w', `${px}px`)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Pin the inline value to what is shown, too: if the clamp ate the drag
    // the store may not change, React then skips the write, and the unclamped
    // number would resurface the moment the window grows.
    const px = Math.round(measure())
    railRef.current?.style.setProperty('--gr-rail-w', `${px}px`)
    commit(px)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const now = measure()
    let next: number | null | undefined
    if (e.key === 'ArrowLeft') next = now - step
    else if (e.key === 'ArrowRight') next = now + step
    else if (e.key === 'Home') next = RAIL_MIN_W
    else if (e.key === 'End') next = RAIL_MAX_W
    else if (e.key === 'Enter') next = null
    if (next === undefined) return
    e.preventDefault()
    commit(next)
  }

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions,
                    jsx-a11y/no-noninteractive-tabindex --
     A focusable `separator` IS interactive in ARIA (the window splitter
     pattern); jsx-a11y classifies the role as static. */
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize bot list"
      aria-valuenow={shown}
      aria-valuemin={RAIL_MIN_W}
      aria-valuemax={RAIL_MAX_W}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="gr-rail-handle"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKeyDown}
    />
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions,
                   jsx-a11y/no-noninteractive-tabindex */
}
