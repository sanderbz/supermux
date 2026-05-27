// Web push service-worker handlers (PUSH milestone — spec TRACK 2 §2).
//
// This file is imported INTO the vite-plugin-pwa / Workbox generated service
// worker via the `importScripts` option (see vite.config.ts). Keeping it as a
// separate, hand-written script (rather than switching the whole SW to
// injectManifest) means the Workbox precache/offline-shell behaviour is left
// completely untouched — we only ADD `push` + `notificationclick` listeners.
//
// It runs in the ServiceWorkerGlobalScope, so `self` is the SW global. No build
// step transforms this file; it is a plain public asset, served + precached
// as-is.

/* global self, clients */

// ── push: show a notification from the server payload ────────────────────────
//
// The server (`server/src/push.rs::send_push`) sends an encrypted JSON payload
// `{ title, body, url }`. We render a notification; `url` is stashed in
// `data.url` for the click handler to deep-link into the app.
//
// SD-13: suppress the OS notification when the app is already in front on this
// device — a same-origin window client that is focused or has
// `visibilityState === 'visible'`. The in-app live surface (SSE → status pill,
// reconnect banner, board / focus updates) already reflects the same
// transition, so a duplicate banner is just noise. Other subscribed devices
// (this is per-device — the SW only sees ITS device's clients) still ring
// normally. We post a synthetic message to any open client so it can surface
// an in-app toast if it wants to, without going through the OS notification
// shade.
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // A non-JSON payload (or none) still shows a sensible default.
    payload = {}
  }

  const title = payload.title || 'supermux'
  const options = {
    body: payload.body || 'An agent needs your attention.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Tag by target URL so repeated pings for the SAME session collapse into a
    // single notification instead of stacking.
    tag: payload.url || 'supermux',
    renotify: true,
    data: { url: payload.url || '/' },
  }

  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      const inFront = windows.some(
        (c) =>
          c.url &&
          new URL(c.url).origin === self.location.origin &&
          (c.focused === true || c.visibilityState === 'visible'),
      )
      if (inFront) {
        // Hand the payload to any open client so it can surface an in-app
        // toast if it wants to. Best-effort — postMessage can throw across
        // some browser states, and a missing in-app handler is fine.
        for (const c of windows) {
          try {
            c.postMessage({ type: 'push', payload })
          } catch {
            /* ignored */
          }
        }
        return
      }
      await self.registration.showNotification(title, options)
    })(),
  )
})

// ── notificationclick: focus an open tab or open the deep-link ───────────────
//
// On tap we focus an already-open supermux tab and navigate it to the target
// (`/focus/<session>`); if none is open we open a fresh window there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    (async () => {
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
