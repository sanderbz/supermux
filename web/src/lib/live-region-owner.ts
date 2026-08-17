/**
 * One state, one voice.
 * ─────────────────────────────────────────────────────────────────────────────
 * A screen reader does not see components, it hears the page. Two `aria-live`
 * regions that happen to describe the SAME state are not two features — they
 * are one sentence said twice, and a doubled sentence is how a live region
 * stops being trusted.
 *
 * The product had exactly that: the global `ReconnectBanner` and the chat
 * surface's own connection chip both say "Reconnecting…" (measured: two
 * un-nested polite regions changing inside the same 500 ms window). Neither is
 * wrong on its own — the chip is the RIGHT owner while a chat surface is
 * mounted, because it is specific to the plane that actually went quiet, and
 * the banner is the right owner everywhere else.
 *
 * So ownership is claimed at runtime rather than argued about statically: the
 * chip claims `connection` while it is actually saying something, the banner
 * asks whether anyone else holds it and goes `aria-live="off"` if so. Exactly
 * one region speaks, and it is always the more specific one.
 *
 * Deliberately NOT React context: the two components live in different subtrees
 * (the banner is above the router, the chip is inside a focus route), so a
 * provider would have to wrap the whole app to join them. A module-level count
 * read through `useSyncExternalStore` is the smaller and more honest mechanism
 * — and it degrades to "the banner speaks", the pre-existing behaviour, if a
 * claim ever leaks.
 */
import * as React from 'react'

let connectionClaims = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/**
 * Take ownership of the `connection` announcement. Returns the release
 * function, so the call site is a one-liner inside `useEffect`.
 */
export function claimConnectionVoice(): () => void {
  connectionClaims += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    connectionClaims -= 1
    emit()
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

const claimed = () => connectionClaims > 0
/** SSR has no mounted chat surface, so nobody has claimed anything. */
const unclaimed = () => false

/**
 * `true` when a more specific region is already announcing connection state —
 * i.e. the global banner must render `aria-live="off"` and stay visual-only.
 */
export function useConnectionVoiceTaken(): boolean {
  return React.useSyncExternalStore(subscribe, claimed, unclaimed)
}

/** Test seam: the count, without a React render. */
export function connectionVoiceClaims(): number {
  return connectionClaims
}
