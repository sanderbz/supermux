/**
 * Tap-the-conversation-to-dismiss, as a pure gate.
 * ─────────────────────────────────────────────────────────────────────────────
 * The phone composer is a `contenteditable` so iOS stops drawing its
 * prev/next/Done accessory bar (`plain-editable.tsx`) — and that bar carried the
 * only NATIVE way to put the keyboard away, so the gesture comes back app-side:
 * a plain tap in the empty transcript blurs the field (`use-tap-to-dismiss.ts`).
 *
 * The DOM plumbing (pointerdown/up on the scroll track, reading the selection at
 * DOWN not UP) needs real events and is Playwright's job — the same split the
 * mic and picker tests call out (no jsdom in this repo). What a unit test CAN
 * pin is the DECISION: `isDismissTap` is the gate without the plumbing, and it
 * is deliberately mean. Each clause below is one way a gesture is NOT a dismiss.
 */
import { describe, expect, test } from 'bun:test'

import { isDismissTap, TAP_MAX_MS, TAP_SLOP_PX } from '../../src/components/chat/use-tap-to-dismiss'

/** The one gesture that DOES dismiss: a still, brief, one-finger tap on the
 *  empty transcript while the composer owns the keyboard. Every test starts from
 *  this and breaks exactly one thing. */
const TAP = {
  travelPx: 0,
  heldMs: 40,
  selection: false,
  onControl: false,
  focusOwnsKeyboard: true,
}

describe('the tap-to-dismiss gate', () => {
  test('a still, brief tap on the empty transcript dismisses', () => {
    expect(isDismissTap(TAP)).toBe(true)
  })

  test('a DRAG is a scroll, not a dismiss', () => {
    expect(isDismissTap({ ...TAP, travelPx: TAP_SLOP_PX })).toBe(false)
    // just under the slop still counts
    expect(isDismissTap({ ...TAP, travelPx: TAP_SLOP_PX - 0.01 })).toBe(true)
  })

  test('a LONG PRESS is a selection gesture, not a dismiss', () => {
    expect(isDismissTap({ ...TAP, heldMs: TAP_MAX_MS })).toBe(false)
    expect(isDismissTap({ ...TAP, heldMs: TAP_MAX_MS - 1 })).toBe(true)
  })

  test('a live SELECTION stands the gesture down (bug #1: reaching for Copy)', () => {
    expect(isDismissTap({ ...TAP, selection: true })).toBe(false)
  })

  test('a tap ON A CONTROL belongs to that control', () => {
    expect(isDismissTap({ ...TAP, onControl: true })).toBe(false)
  })

  test('with nothing focused there is no keyboard to put away', () => {
    expect(isDismissTap({ ...TAP, focusOwnsKeyboard: false })).toBe(false)
  })
})
