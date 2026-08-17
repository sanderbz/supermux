/**
 * The ONE armed-confirm idiom (B5/T9).
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * The same class of destructive action was guarded three different ways, across
 * six call sites, with no shared code:
 *
 *   A  4 s timer + an icon→confirm/cancel morph      `session-tile/tile.tsx`
 *   B  4 s timer, same button, label/colour change   `settings/hosts-section.tsx`
 *   C  UNTIMED morph into a `Cancel / <verb>` pair   `archived-sheet.tsx` ×2,
 *                                                    `kill-teammate-button.tsx`,
 *                                                    `claude-tools-sheet.tsx`
 *
 * Three mechanisms meant three sets of bugs. Variant B never cleared its timer
 * on unmount — a live setState-after-unmount every time the section closed
 * while armed. The four variant-C sites stayed armed indefinitely, so a button
 * you glanced at an hour ago was still one click from firing. None of the three
 * guarded a fast double-click.
 *
 * ── Behaviour change, stated ────────────────────────────────────────────────
 * The four untimed sites GAIN a 4 s window. That is deliberate: an armed
 * destructive button with no expiry is a trap that gets more dangerous the
 * longer you leave it. It is a change users will feel, so the PR says so.
 *
 * ── Why the machine is framework-free ───────────────────────────────────────
 * [`createArmedConfirm`] is plain TypeScript — no React — and the hook is a
 * thin binding over it. The behaviours worth protecting here are TEMPORAL
 * (expiry, disposal while armed, two presses inside one tick), and testing
 * those through a component renderer would mean pulling in a hook-testing
 * dependency this repo does not otherwise have. A pure machine is testable with
 * nothing but timers, which is exactly what `armed-confirm.test.tsx` does.
 */
import * as React from 'react'

/** The shared arm window. One constant, every site. */
export const ARM_WINDOW_MS = 4000

export interface ArmedConfirm {
  /** Is the button currently armed (one more press fires)? */
  armed: boolean
  /** Press the action: arms it, or fires it if already armed. */
  press: () => void
  /** Disarm without firing — the explicit Cancel. */
  cancel: () => void
}

export interface ArmedMachine {
  /** Current armed state. */
  readonly armed: boolean
  press: () => void
  cancel: () => void
  /** Point the machine at a new confirm callback. Called from an effect when a
   *  React caller re-renders with a fresh closure — swapping the callback must
   *  NOT rebuild the machine, or the armed state would vanish mid-interaction. */
  setOnConfirm: (fn: () => void) => void
  /** Subscribe to armed-state changes. Returns an unsubscribe. */
  subscribe: (fn: () => void) => () => void
  /** Clear any pending timer. Idempotent; safe after disposal. */
  dispose: () => void
}

/**
 * The armed-confirm state machine, without React.
 *
 * The confirm callback is held internally and swapped via [`setOnConfirm`]
 * rather than captured, so a React caller re-rendering with a fresh inline
 * closure does not rebuild the machine — which would drop the armed state
 * mid-interaction.
 */
export function createArmedConfirm(
  onConfirm: () => void,
  windowMs: number = ARM_WINDOW_MS,
): ArmedMachine {
  let confirm = onConfirm
  let armed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const fn of listeners) fn()
  }
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const setArmed = (next: boolean) => {
    if (armed === next) return
    armed = next
    emit()
  }

  return {
    get armed() {
      return armed
    },
    press() {
      if (armed) {
        // Fire. Disarm FIRST so a callback that synchronously re-renders sees
        // a settled machine, and so a second press landing in the same tick
        // cannot fire twice.
        clear()
        setArmed(false)
        confirm()
        return
      }
      clear()
      setArmed(true)
      timer = setTimeout(() => {
        timer = null
        setArmed(false)
      }, windowMs)
    },
    cancel() {
      clear()
      setArmed(false)
    },
    setOnConfirm(fn) {
      confirm = fn
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      clear()
      listeners.clear()
    },
  }
}

export interface UseArmedConfirmOptions {
  /** How long the armed state survives before disarming itself. */
  window?: number
  /** Runs when the armed action is confirmed. */
  onConfirm: () => void
}

/**
 * Two-press confirmation with a self-expiring armed state.
 *
 * The machine is disposed on unmount, which is the bug variant B shipped: a
 * component unmounting while armed left a timer that woke up and wrote state
 * into a dead tree.
 */
export function useArmedConfirm({
  window: windowMs = ARM_WINDOW_MS,
  onConfirm,
}: UseArmedConfirmOptions): ArmedConfirm {
  // Created once, in a lazy initializer. `window` is read at construction, so a
  // call site wanting a different arm window passes a literal — none needs to
  // change it mid-life.
  const [machine] = React.useState(() => createArmedConfirm(onConfirm, windowMs))

  // Point the machine at the latest callback from an EFFECT. Call sites pass
  // inline closures, so `onConfirm` is a new function on every parent render;
  // rebuilding the machine for that would drop the armed state mid-interaction,
  // and reading it during render is exactly what the React lint rules (rightly)
  // forbid. A setter is the honest way to say "same machine, newer callback".
  React.useEffect(() => {
    machine.setOnConfirm(onConfirm)
  }, [machine, onConfirm])

  // THE unmount fix: variant B left a timer that woke up and wrote state into a
  // dead tree every time its section closed while armed.
  React.useEffect(() => () => machine.dispose(), [machine])

  const armed = React.useSyncExternalStore(
    machine.subscribe,
    () => machine.armed,
    () => false,
  )

  return { armed, press: machine.press, cancel: machine.cancel }
}
