// Web push service-worker handlers (PUSH milestone — spec TRACK 2 §2; extended
// in B5/T3.2 for the tier-aware payload and the PWA badge).
//
// This file is imported INTO the vite-plugin-pwa / Workbox generated service
// worker via the `importScripts` option (see vite.config.ts). Keeping it as a
// separate, hand-written script (rather than switching the whole SW to
// injectManifest) means the Workbox precache/offline-shell behaviour is left
// completely untouched — we only ADD `push`, `notificationclick` and `message`
// listeners.
//
// It runs in the ServiceWorkerGlobalScope, so `self` is the SW global. No build
// step transforms this file; it is a plain public asset, served + precached
// as-is.
//
// ── what B5 changed, and what it kept ────────────────────────────────────────
//
// KEPT: the `tag`/`renotify` coalescing pair, and the focus-or-open
// `notificationclick` handler — both unchanged in substance.
//
// KEPT BUT SCOPED: banner suppression while the app is in front. The old rule
// suppressed on ANY focused same-origin window, which meant a user reading
// session A never heard that session B was blocked — and the payload was then
// dropped into a void, because no in-app listener existed. `decideDisplay` now
// asks "is the user looking at THIS?" instead of "is the app open?", and the
// payload is ALWAYS handed to open windows so the app can surface it in-app.
//
// NEW: `navigator.setAppBadge` / `clearAppBadge` (the home-screen count — the
// genuine gap; there were zero occurrences of either in `web/` before this),
// tier-aware `renotify`, `closeTag`, and a `message` listener so the page can
// tell the SW what the user has just seen. The page owns that truth: without it
// the lock screen kept a "needs you" card for a dialog already answered in-app.

/* global self, clients */

// The server payload (see server/src/notify.rs::PushPayload):
//   { title, body, url, tier, session, badge, icon, tag, renotify }
// `tier` is one of attention | unread | error | schedule.

/**
 * Should this device SHOW a banner, given the windows currently open on it?
 *
 * The rule is "is the user already looking at THIS", not "is the app open".
 * The old rule suppressed on any visible same-origin window, which meant a user
 * reading session A never heard that session B was blocked — and then dropped
 * the payload into a void, because no in-app listener existed. Both halves are
 * fixed: suppression is now scoped to the exact target, and the payload is
 * always handed to open windows so the app can surface it in-app.
 *
 * Pure: takes the client list rather than reaching for `clients`, so it is
 * unit-testable without a service-worker scope.
 *
 * @param {object} payload  the server payload
 * @param {Array<{url?: string, focused?: boolean, visibilityState?: string}>} windowClients
 * @returns {{show: boolean, reason: string}}
 */
function decideDisplay(payload, windowClients) {
  const target = pathOf(payload && payload.url)
  const looking = (windowClients || []).some((c) => {
    if (!c || !c.url) return false
    if (c.focused !== true && c.visibilityState !== 'visible') return false
    return pathOf(c.url) === target
  })
  return looking
    ? { show: false, reason: 'already-viewing' }
    : { show: true, reason: 'not-viewing' }
}

/** Path component of a URL, absolute or relative, ignoring query + fragment.
 *  `/focus/x#pending` and `/focus/x` are the same PLACE — the fragment only
 *  tells the app where to scroll once it is there. */
function pathOf(url) {
  if (!url) return '/'
  try {
    return new URL(url, self.location.origin).pathname
  } catch {
    return String(url).split('#')[0].split('?')[0] || '/'
  }
}

/**
 * The `showNotification` options for a payload.
 *
 * `tag` is the server's coalescing slot ("session:<name>") so a bot occupies
 * exactly ONE notification and each new one replaces it in place. `renotify`
 * comes from the tier: a blocking state may buzz again, a calm one updates
 * silently.
 */
function notificationOptions(payload) {
  const p = payload || {}
  return {
    body: p.body || 'An agent needs your attention.',
    icon: p.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: p.tag || p.url || 'supermux',
    renotify: p.renotify === true,
    data: { url: p.url || '/', tier: p.tier || 'attention', session: p.session || null },
  }
}

// Badging is a NICETY, and on some builds it is a nicety that takes the whole
// renderer with it: chrome-headless-shell ships `navigator.setAppBadge` but no
// BadgeService binder, so the first call kills the process with
// "No binder found for interface blink.mojom.BadgeService" — feature detection
// is not enough, because the capability lies. So the FIRST failure latches
// badging off for the life of this service worker: one bad call, never a
// second. Both the synchronous throw and the async rejection latch.
let badgingBroken = false

/** Apply the home-screen / dock badge. 0 clears it rather than showing a zero. */
function applyBadge(count) {
  if (badgingBroken) return undefined
  const n = Number(count) || 0
  const latch = (p) =>
    p && typeof p.catch === 'function'
      ? p.catch(() => {
          badgingBroken = true
        })
      : p
  try {
    if (n > 0 && typeof self.navigator?.setAppBadge === 'function') {
      return latch(self.navigator.setAppBadge(n))
    }
    if (typeof self.navigator?.clearAppBadge === 'function') {
      return latch(self.navigator.clearAppBadge())
    }
  } catch {
    // Unsupported (or hostile) badging — never let it break the push, and
    // never call it again.
    badgingBroken = true
  }
  return undefined
}

// Exposed for the unit tests (and harmless in production — the SW global is
// not reachable from a page).
self.__pushSw = { decideDisplay, notificationOptions, applyBadge, pathOf }

// ── push ─────────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // A non-JSON payload (or none) still shows a sensible default.
    payload = {}
  }

  const title = payload.title || 'supermux'

  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // The badge reflects attention state whether or not a banner is shown —
      // a suppressed banner still happened.
      await applyBadge(payload.badge)

      // Always hand the payload to open windows: the in-app surface decides
      // what to do with it (a toast for a blocking tier, nothing for a calm
      // one — the roster's own tier dot is the calm surface).
      for (const c of windows) {
        try {
          c.postMessage({ type: 'push', payload })
        } catch {
          /* postMessage can throw across some browser states — best-effort */
        }
      }

      if (decideDisplay(payload, windows).show) {
        await self.registration.showNotification(title, notificationOptions(payload))
      }
    })(),
  )
})

// ── notificationclick: focus an open tab or open the deep-link ───────────────
//
// On tap we focus an already-open supermux tab and navigate it to the target
// (`/focus/<session>`, with `#pending` when something is waiting on an answer);
// if none is open we open a fresh window there. The whole slot for that session
// is then cleared: after a tap, the lock screen and the app must agree.
self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {}
  const targetUrl = data.url || '/'
  const tag = event.notification.tag
  event.notification.close()

  event.waitUntil(
    (async () => {
      await closeTag(tag)

      const allClients = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      // Prefer an existing supermux window: focus it and navigate to the target.
      for (const client of allClients) {
        try {
          const url = new URL(client.url)
          if (url.origin === self.location.origin) {
            await client.focus()
            if ('navigate' in client) {
              try {
                await client.navigate(targetUrl)
              } catch {
                // navigate can reject across some origins/states — focus is enough.
              }
            }
            return
          }
        } catch {
          // Malformed client URL — skip it.
        }
      }
      // No window open — open a new one at the deep-link.
      if (clients.openWindow) {
        await clients.openWindow(targetUrl)
      }
    })(),
  )
})

/** Close every live notification in one coalescing slot. */
async function closeTag(tag) {
  if (!tag) return
  try {
    const live = await self.registration.getNotifications({ tag })
    for (const n of live) n.close()
  } catch {
    /* getNotifications is unavailable in some scopes — best-effort */
  }
}

// ── message: the app telling the SW what it has just seen ────────────────────
//
// The page owns the truth about what the user is looking at, so it drives the
// one thing the SW cannot know: which session's banner is now stale.
//
// The BADGE is deliberately NOT applied from here. Every message on this channel
// is posted BY the page (push-bridge.tsx), and the page can only post while it
// is open — at which point `push-bridge.tsx::setBadge` has ALREADY applied the
// same count from the window context (on iOS the page and the SW share one
// badge, and the page is the authoritative writer). Re-applying it in the worker
// was pure redundancy, and it was also a live renderer-crash hazard: on
// chrome-headless-shell `navigator.setAppBadge` EXISTS but has no BadgeService
// binder behind it, so the first worker call HARD-CRASHES the render process on
// the very next navigation. A capability that lies cannot be feature-detected,
// so the defence is to not make the call from a context that doesn't need to.
// Closed-app badging — the case the page can't cover because it isn't running —
// is still applied in the `push` handler above, guarded by the `applyBadge`
// latch. See tests/e2e/smoke/sw-lifecycle.spec.ts for the crash regression.
self.addEventListener('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'notification-seen') {
    event.waitUntil(closeTag(msg.tag || (msg.session ? `session:${msg.session}` : null)))
  }
  // A `{type:'badge'}` message is now a no-op — the open page owns the badge.
  // Tolerated (not rejected) so an older/newer page build posting one is
  // harmless.
})
