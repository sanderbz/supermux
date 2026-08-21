// PWA bundle-adoption store — the path a deploy takes to actually REACH a
// long-open PWA.
//
// THE BUG THIS FIXES. `vite.config.ts` runs vite-plugin-pwa in `prompt` mode
// (and it MUST — `autoUpdate` reloads the document out from under the user on
// every activation, the measured 31-characters-destroyed data-loss bug). In
// `prompt` mode a freshly deployed app shell is fetched and installed as a
// WAITING service worker; the browser will not let it take control until every
// tab/window of the PWA has closed. For a daily-driver home-screen app that is
// ~never — so the owner deployed fix after fix, the server ran the new bundle,
// and his PWA kept serving the OLD cached one with a "new version waiting" hint
// that never resolved.
//
// THIS MODULE IS THE ADOPTION PATH. `lib/pwa.ts` hands us a `reload` thunk the
// moment vite-plugin-pwa reports a waiting worker (its `onNeedRefresh`). Calling
// that thunk posts SKIP_WAITING to the waiting worker and reloads the page onto
// the new bundle once it takes control (vite-plugin-pwa's `updateSW(true)` —
// messageSkipWaiting + a `controllerchange` → `location.reload()`). We then
// either:
//
//   * ADOPT IT SILENTLY when the app is idle — no unsent composer text AND the
//     tab is backgrounded, so the user is not looking and loses nothing; or
//   * SURFACE `waiting = true` so the shell shows a one-tap "Reload to update"
//     button (`components/pwa/sw-update-prompt.tsx`) that calls `adopt()`.
//
// Either way the stale bundle is left behind and the hint RESOLVES: after the
// reload the new worker is the controller, nothing is waiting, and
// `getSWUpdateWaiting()` reads false again. No banner survives the adoption.
//
// The state machine (`shouldAutoAdopt`, `markWaiting`) is deliberately free of
// React and only touches `document`/`sessionStorage` behind typeof-guards, so it
// unit-tests headlessly (`tests/unit/sw-update.test.ts`).

import { hasUnsentDraft } from '@/components/chat/composer-draft'

/** Adopts the waiting worker: skipWaiting + reload onto the new bundle. */
type ReloadFn = () => void

let waiting = false
let reloadFn: ReloadFn | null = null
let visibilityArmed = false
let controllerChangeArmed = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** `useSyncExternalStore` subscribe: fires whenever `waiting` flips. */
export function subscribeSWUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Snapshot: is a freshly deployed app bundle waiting for the user to adopt it?
 *  Drives the shell's "Reload to update" affordance. Reads false again once the
 *  page has reloaded onto the new bundle — so the affordance never persists past
 *  the adoption it triggers. */
export function getSWUpdateWaiting(): boolean {
  return waiting
}

/** The idle conditions, read from the live environment. Guarded so the store
 *  runs under a bare test runner with no `document`. */
function readEnv(): { hasUnsentDraft: boolean; hidden: boolean } {
  const hidden =
    typeof document !== 'undefined' &&
    typeof document.visibilityState === 'string' &&
    document.visibilityState === 'hidden'
  return { hasUnsentDraft: hasUnsentDraft(), hidden }
}

/**
 * IDLE — safe to reload WITHOUT asking — is: nothing the user typed is unsent
 * AND the tab is backgrounded (the user is not looking at it).
 *
 * A VISIBLE tab with no draft is deliberately NOT auto-reloaded: a surprise
 * reload mid-read is jarring even when it destroys no data, so it gets the
 * one-tap button instead and adopts the next time it goes to the background.
 * Unsent text vetoes an auto-reload outright, visible or not.
 */
export function shouldAutoAdopt(env: {
  hasUnsentDraft: boolean
  hidden: boolean
}): boolean {
  if (env.hasUnsentDraft) return false
  return env.hidden
}

/** Perform the adoption now: skipWaiting + reload onto the new bundle. No-op
 *  when nothing is waiting. Called by the "Reload to update" button and by the
 *  idle auto-adopt paths. */
export function adopt(): void {
  reloadFn?.()
}

/** Arm a ONE-TIME listener so a tab that was visible when the update landed
 *  adopts silently the next time it goes to the background (still idle-guarded:
 *  unsent text keeps it waiting). This is what makes a long-open PWA converge on
 *  the new bundle without ever interrupting the user — the near-universal path
 *  for a phone home-screen app is "user switches away", and that is when we take
 *  the update. */
function armVisibilityAdopt(): void {
  if (visibilityArmed) return
  if (
    typeof document === 'undefined' ||
    typeof document.addEventListener !== 'function'
  ) {
    return
  }
  visibilityArmed = true
  document.addEventListener('visibilitychange', () => {
    if (waiting && shouldAutoAdopt(readEnv())) adopt()
  })
}

/**
 * Called by `lib/pwa.ts` when vite-plugin-pwa reports a WAITING worker. Takes
 * the thunk that adopts it (skipWaiting + reload) and decides between a silent
 * idle adoption and surfacing the one-tap button.
 */
export function markWaiting(reload: ReloadFn): void {
  reloadFn = reload
  if (shouldAutoAdopt(readEnv())) {
    reload()
    return
  }
  waiting = true
  emit()
  armVisibilityAdopt()
}

/**
 * Retract the "waiting" state — the page is CURRENT (its built sha matches what
 * the server is serving). The version-guard calls this on every check that finds
 * NO mismatch so a bar surfaced by an earlier poll (or a since-adopted deploy)
 * disappears on its own instead of lingering. Notifies subscribers only when it
 * actually flips, so it is cheap to call on every poll. No effect on the reload
 * thunk — a genuinely waiting SW worker can still be adopted later.
 */
export function markCurrent(): void {
  if (!waiting) return
  waiting = false
  emit()
}

/** The minimal shape of `navigator.serviceWorker` this module touches, so the
 *  controllerchange installer can be driven by a stub in a DOM-less test. */
type SWContainer = {
  controller: unknown
  addEventListener: (type: 'controllerchange', fn: () => void) => void
}

/**
 * Install the ONE-TIME `controllerchange` reload — the piece that makes a
 * skipWaiting+clientsClaim service worker (see vite.config.ts) actually LAND the
 * page on its freshly-activated bundle.
 *
 * WHY THIS IS SEPARATE FROM the `onNeedRefresh`/version-guard paths: on iOS
 * standalone the client-side "tap to adopt" (updateSW(true)/SKIP_WAITING) was
 * never reliably delivered, so the new SW parked as a WAITING worker and the
 * fresh precache never activated. With skipWaiting+clientsClaim the new SW now
 * activates and CLAIMS this page on its own — which fires exactly one
 * `controllerchange`. We turn that into a reload onto the new bundle.
 *
 * DRAFT-SAFE, the SAME way every other adoption path is: we route through
 * `markWaiting`, so an unsent composer draft (or a visible tab mid-interaction)
 * vetoes the silent reload and surfaces the one-tap bar instead; only a truly
 * idle tab reloads on its own.
 *
 * INITIAL-CLAIM GUARD: clientsClaim ALSO fires `controllerchange` the first time
 * a brand-new SW claims a page that loaded uncontrolled (first-ever visit) —
 * that page is already on the fresh bundle, so reloading it would be a pointless
 * flash. We snapshot `controller` at install time and act only when an EXISTING
 * controller is being REPLACED (a genuine update takeover).
 *
 * Installed exactly once (module flag) and cannot loop: `controllerchange` fires
 * once per activation, and after the reload the new SW controls the page from
 * the first byte, so no further activation — hence no further event — occurs.
 */
export function installControllerChangeReload(
  container?: SWContainer,
  reload: ReloadFn = () => location.reload(),
): void {
  if (controllerChangeArmed) return
  const sw: SWContainer | undefined =
    container ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? (navigator.serviceWorker as unknown as SWContainer)
      : undefined)
  if (!sw || typeof sw.addEventListener !== 'function') return
  controllerChangeArmed = true
  // null now → first-visit claim (skip the reload); set now → an update will
  // REPLACE this controller (reload onto its bundle).
  const hadController = !!sw.controller
  sw.addEventListener('controllerchange', () => {
    if (!hadController) return
    markWaiting(reload)
  })
}

/** TEST SEAM: reset module state between cases. */
export function __resetSWUpdateForTest(): void {
  waiting = false
  reloadFn = null
  visibilityArmed = false
  controllerChangeArmed = false
  listeners.clear()
}
