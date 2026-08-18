// Tap the conversation to put the keyboard away (the WhatsApp gesture).
// ─────────────────────────────────────────────────────────────────────────────
// THE DEBT THIS PAYS. The phone composer is a `contenteditable` so iOS stops
// drawing its form-assistant bar above the keyboard (`plain-editable.tsx`).
// That bar carried the only NATIVE way to put the keyboard away — the Done
// button on its right — so removing it without replacing the gesture would
// leave a phone user with a keyboard they cannot dismiss without sending or
// leaving the screen. Every chat app that made this same trade replaced it the
// same way: a tap on the conversation dismisses the keyboard.
//
// WHAT COUNTS AS THAT TAP, and the list is deliberately mean:
//
//   · ONE finger, < TAP_SLOP_PX of travel, < TAP_MAX_MS of press. A drag is a
//     scroll and a long press is a selection; neither is a request to dismiss.
//     (The same three numbers as the terminal's tap-vs-swipe gate in
//     `routes/focus/mobile.tsx` — one definition of "a tap" on this surface.)
//   · NOTHING SELECTED, anywhere. The gesture that ends a drag-select lands as
//     a pointerup, and blurring there would fight BUG 1's whole repair: the
//     reader has a selection up and is reaching for Copy. Same predicate both
//     sides consult (`selection.ts`).
//   · NOT ON A CONTROL. A tap on a button, a link, a disclosure, a card's own
//     row is that control's tap. Only the empty transcript dismisses.
//   · SOMETHING IS ACTUALLY FOCUSED. With no keyboard up there is nothing to
//     put away, and blurring `<body>` would be a no-op with a cost.
//
// COARSE POINTERS ONLY. On a desktop a click in the transcript that quietly
// stole the caret out of the composer would be a regression, and
// `arm-composer-focus.ts` deliberately puts it back there — the two would loop.
// There is no keyboard to dismiss on a mouse anyway.

import * as React from 'react'

import { hasTextSelection } from './selection'

/** Max total finger travel that still counts as a tap. */
const TAP_SLOP_PX = 10
/** Max press duration that still counts as a tap. */
const TAP_MAX_MS = 500

/** Controls whose tap belongs to them, not to the dismiss gesture. */
const INTERACTIVE =
  'button, a[href], input, textarea, select, summary, label, [contenteditable=""], ' +
  '[contenteditable="true"], [contenteditable="plaintext-only"], [role="button"], ' +
  '[role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], ' +
  '[role="switch"], [role="textbox"], [role="combobox"], [role="slider"]'

/** Would blurring this actually put a soft keyboard away? */
function isKeyboardOwner(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

/**
 * Blur the focused field on a plain tap inside `hostRef`.
 *
 * Native listeners rather than React props because the host is the scroll track
 * (`chat-surface.tsx`), which the panel owns as a REF and hands down — there is
 * no element here to put an `onPointerUp` on. Non-passive is unnecessary:
 * nothing is prevented, the gesture is only observed.
 */
export function useTapToDismissKeyboard(
  hostRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  React.useEffect(() => {
    const host = hostRef.current
    if (!enabled || !host) return
    let candidate: { x: number; y: number; t: number; id: number; selection: boolean } | null = null

    const onDown = (e: PointerEvent) => {
      // A second concurrent pointer is multi-touch (pinch-zoom on a code block,
      // a two-finger scroll) — never a tap. Invalidate rather than replace.
      if (candidate && candidate.id !== e.pointerId) {
        candidate = null
        return
      }
      if (e.pointerType === 'mouse') return
      // THE SELECTION IS READ HERE, not at pointerup. A touch DOWN outside a
      // selection is what dismisses it — by the time the finger lifts, the
      // range is already gone and the guard would see a clean slate on the very
      // gesture it exists to stand down for.
      candidate = {
        x: e.clientX,
        y: e.clientY,
        t: Date.now(),
        id: e.pointerId,
        selection: hasTextSelection(),
      }
    }

    const onUp = (e: PointerEvent) => {
      const cand = candidate
      candidate = null
      if (!cand || cand.id !== e.pointerId) return
      if (Math.hypot(e.clientX - cand.x, e.clientY - cand.y) >= TAP_SLOP_PX) return
      if (Date.now() - cand.t >= TAP_MAX_MS) return
      // The reader is holding a selection and reaching for Copy (BUG 1) —
      // either when the finger went down, or still now.
      if (cand.selection || hasTextSelection()) return
      const target = e.target
      if (target instanceof Element && target.closest(INTERACTIVE)) return
      const active = document.activeElement
      if (!isKeyboardOwner(active)) return
      active.blur()
    }

    const onCancel = () => {
      candidate = null
    }

    host.addEventListener('pointerdown', onDown)
    host.addEventListener('pointerup', onUp)
    host.addEventListener('pointercancel', onCancel)
    return () => {
      host.removeEventListener('pointerdown', onDown)
      host.removeEventListener('pointerup', onUp)
      host.removeEventListener('pointercancel', onCancel)
    }
  }, [enabled, hostRef])
}

/** Exported for the unit net: the gate, without the DOM plumbing. */
export function isDismissTap(gesture: {
  travelPx: number
  heldMs: number
  selection: boolean
  onControl: boolean
  focusOwnsKeyboard: boolean
}): boolean {
  if (gesture.travelPx >= TAP_SLOP_PX) return false
  if (gesture.heldMs >= TAP_MAX_MS) return false
  if (gesture.selection) return false
  if (gesture.onControl) return false
  return gesture.focusOwnsKeyboard
}

export { TAP_MAX_MS, TAP_SLOP_PX }
