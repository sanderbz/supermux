/**
 * T9 — the one armed-confirm idiom.
 *
 * This replaced three mechanisms across six call sites. What is asserted here
 * is the behaviour each of those three got subtly wrong, so the consolidation
 * cannot regress into any of them:
 *
 * * variant A/B armed for 4 s — the window must EXPIRE (variant C never did);
 * * variant B never cleared its timer on unmount — a live setState against a
 *   dead component every time the settings section closed while armed;
 * * none of them guarded a fast double-click, which fires the destructive
 *   action on what the user experienced as a single interaction.
 */
import { describe, expect, mock, test } from 'bun:test'

import {
  ARM_WINDOW_MS,
  createArmedConfirm,
} from '../../src/hooks/use-armed-confirm'

/** Drive the machine directly. The React hook is a thin binding over it (a
 *  `useSyncExternalStore` subscription and a dispose-on-unmount), so the
 *  behaviour worth protecting — all of it temporal — lives here. */
const make = (onConfirm: () => void, windowMs = ARM_WINDOW_MS) =>
  createArmedConfirm(onConfirm, windowMs)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('two presses, not one', () => {
  test('the first press arms, and does NOT fire', () => {
    const onConfirm = mock(() => {})
    const m = make(onConfirm)

    expect(m.armed).toBe(false)
    m.press()

    expect(m.armed).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(0)
    m.dispose()
  })

  test('the second press fires and disarms', () => {
    const onConfirm = mock(() => {})
    const m = make(onConfirm)

    m.press()
    m.press()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(m.armed).toBe(false)
    m.dispose()
  })

  test('cancel disarms without firing', () => {
    const onConfirm = mock(() => {})
    const m = make(onConfirm)

    m.press()
    m.cancel()

    expect(m.armed).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(0)

    // …and a press after cancelling arms again rather than firing. Without
    // this, cancel would leave a button that looks safe and is not.
    m.press()
    expect(m.armed).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(0)
    m.dispose()
  })
})

describe('the armed state expires', () => {
  test('it disarms itself after the window', async () => {
    // THE behaviour change for the four variant-C sites, which armed forever. A
    // destructive button you glanced at an hour ago must not still be one click
    // from firing.
    const onConfirm = mock(() => {})
    const m = make(onConfirm, 30)

    m.press()
    expect(m.armed).toBe(true)

    await sleep(60)

    expect(m.armed).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(0)
    m.dispose()
  })

  test('a press after expiry re-arms rather than firing', async () => {
    const onConfirm = mock(() => {})
    const m = make(onConfirm, 30)

    m.press()
    await sleep(60)
    m.press()

    // The dangerous bug this guards: if expiry cleared the flag but not the
    // "already pressed once" intent, the post-expiry press would fire.
    expect(onConfirm).toHaveBeenCalledTimes(0)
    expect(m.armed).toBe(true)
    m.dispose()
  })

  test('the shared window is 4s — the value two of the three variants used', () => {
    expect(ARM_WINDOW_MS).toBe(4000)
  })
})

describe('the bugs the three variants shipped', () => {
  test('disposing while armed leaves no timer behind', async () => {
    // Variant B's live setState-after-unmount: `hosts-section.tsx` armed a
    // delete on a 4 s timer and never cleared it, so closing the section left a
    // timer that woke up and wrote state into a dead tree. `dispose` is what
    // the hook calls on unmount.
    const onConfirm = mock(() => {})
    const m = make(onConfirm, 20)
    const seen: boolean[] = []
    m.subscribe(() => seen.push(m.armed))

    m.press()
    expect(seen).toEqual([true])
    m.dispose()

    await sleep(50)
    // No disarm notification after disposal, and nothing fired.
    expect(seen).toEqual([true])
    expect(onConfirm).toHaveBeenCalledTimes(0)
  })

  test('a fast double-click fires exactly once', () => {
    // Two presses inside one render pass. Deriving the decision from the state
    // SETTER rather than from a stale `armed` closure is what makes this one
    // rather than two.
    const onConfirm = mock(() => {})
    const m = make(onConfirm)

    m.press()
    m.press()

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(m.armed).toBe(false)
    m.dispose()
  })

  test('re-arming clears the previous timer instead of stacking them', async () => {
    const onConfirm = mock(() => {})
    const m = make(onConfirm, 40)

    m.press()
    m.cancel()
    m.press()

    // Still armed at 25ms: the second arm's window is measured from ITS press,
    // not shortened by the first one's leftover timer.
    await sleep(25)
    expect(m.armed).toBe(true)
    m.dispose()
  })
})
