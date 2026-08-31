/**
 * COLD START — "is this the first paint of this page load, on the path the page
 * loaded at?"
 *
 * "Open where I left off" is a LAUNCH behaviour, not a navigation behaviour.
 * Reopening the last conversation every time the user walks back to `/` would
 * fight them: they closed that pane on purpose. So the restore fires exactly
 * once, on the surface the browser actually booted onto.
 *
 * Two facts, kept apart on purpose:
 *
 *   • {@link BOOT_PATH} — the path the SPA booted at. Captured at MODULE LOAD,
 *     and this module is imported from `main.tsx` (the entry chunk) precisely so
 *     the capture happens at boot and not when some lazy route chunk finally
 *     arrives. Without that, a cold load onto `/files` followed by a walk to `/`
 *     would look exactly like a cold load onto `/`.
 *
 *   • {@link isColdStartMount} — memoised, so React StrictMode's deliberate
 *     double-mount (and any re-render) gets the SAME answer instead of a
 *     "first call wins" coin flip.
 *
 * Whether the restore has already been ATTEMPTED is separate
 * ({@link claimConversationRestore}) because the attempt has to wait for the
 * session/company queries to resolve — deciding "that bot is gone" against a
 * list that has not arrived is how a scope gets silently thrown away.
 */

/** The path the browser was on when the app booted. `/` under SSR/bun. */
export const BOOT_PATH: string =
  typeof window === 'undefined' ? '/' : window.location.pathname

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  return norm(a) === norm(b)
}

let coldStartAnswer: boolean | null = null
let restoreClaimed = false

/**
 * Is the component mounting at `pathname` the boot surface of this page load?
 *
 * Memoised on the first call so it is stable across StrictMode's double mount.
 * A later mount at a DIFFERENT path re-uses the first answer, which is
 * deliberate: the gate that stops a second restore is
 * {@link claimConversationRestore}, not this.
 */
export function isColdStartMount(pathname: string): boolean {
  if (coldStartAnswer === null) coldStartAnswer = samePath(pathname, BOOT_PATH)
  return coldStartAnswer
}

/**
 * Claim the ONE conversation restore this page load gets. `true` for the first
 * caller, `false` forever after — so a remount, a StrictMode replay, or a walk
 * back to the roster cannot reopen a pane the user has since closed.
 *
 * Call it only once the data needed to judge eligibility has actually resolved.
 */
export function claimConversationRestore(): boolean {
  if (restoreClaimed) return false
  restoreClaimed = true
  return true
}

/** Has the restore already been claimed? (Read-only; used by the roster's
 *  persist gate so the mount's empty selection cannot erase what we stored.) */
export function conversationRestoreClaimed(): boolean {
  return restoreClaimed
}

/** TEST SEAM — reset both gates so a unit test can replay a fresh page load.
 *  Never called by app code. */
export function resetColdStartForTests(): void {
  coldStartAnswer = null
  restoreClaimed = false
}
