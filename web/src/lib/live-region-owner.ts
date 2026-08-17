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
let chatSurfaceClaims = 0
let turnClaims = 0
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

/**
 * Declare that a chat surface is mounted. Same mechanism, a different question:
 * not "who speaks" but "who owns the outage story on screen".
 *
 * The chat plane's documented contract is that a reconnect NEVER blanks what is
 * on screen — the transcript stays, under a chip that says it is not current
 * (`server/src/sessions/chat/tailer.rs`, and `BRAND.md`'s connection
 * vocabulary). `ConnectionOverlay` is a `fixed inset-0` curtain, so during a
 * TOTAL backend outage it covered that chip 416 ms later and the promise became
 * false in exactly the scenario the reconnect specs test — while
 * `toBeVisible()` kept passing, because Playwright's visibility ignores
 * occlusion.
 *
 * Presence, not chip state, on purpose: keying the suppression off "the chip is
 * currently saying something" would let the curtain paint for the few hundred
 * milliseconds before the socket notices, i.e. a flash of exactly the thing
 * being suppressed.
 */
export function claimChatSurface(): () => void {
  chatSurfaceClaims += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    chatSurfaceClaims -= 1
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

const chatMounted = () => chatSurfaceClaims > 0

/**
 * `true` when a chat surface is on screen and therefore owns the outage story —
 * i.e. the full-screen `ConnectionOverlay` must stand down so the transcript and
 * its honesty chip stay visible, as documented.
 */
export function useChatSurfaceMounted(): boolean {
  return React.useSyncExternalStore(subscribe, chatMounted, unclaimed)
}

const turnTaken = () => turnClaims > 0

/**
 * `true` when the chat layer's announcer is mounted and therefore owns the turn
 * story — i.e. the terminal route's `TerminalTurnAnnouncer` must stand down so
 * a screen-reader user hears "Claude is working." once, not twice.
 */
export function useTurnVoiceTaken(): boolean {
  return React.useSyncExternalStore(subscribe, turnTaken, unclaimed)
}

/**
 * Take ownership of the TURN announcement ("Claude is working." / "Claude
 * replied."). Same mechanism, third question.
 *
 * Both renderers can be mounted inside the same focus route — the chat renderer
 * is a toggle, not a route — and both need this sentence. The chat layer is the
 * more specific owner (it can also see an ask and a hand-off, which the terminal
 * surface cannot), so it claims, and `TerminalTurnAnnouncer` goes silent for as
 * long as the claim is held. Degrades to "the terminal announcer speaks", which
 * is the surface a user gets by default today.
 */
export function claimTurnVoice(): () => void {
  turnClaims += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    turnClaims -= 1
    emit()
  }
}

/** Test seam: the counts, without a React render. */
export function connectionVoiceClaims(): number {
  return connectionClaims
}
export function turnVoiceClaims(): number {
  return turnClaims
}
export function chatSurfaceMountCount(): number {
  return chatSurfaceClaims
}
