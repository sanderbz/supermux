// PWA boot wiring.
//
// Registers the vite-plugin-pwa service worker and injects the iOS launch-
// splash <link> tags. Called once from main.tsx. Everything here is a no-op in
// environments without a service worker (dev, SSR, old browsers).
//
// SAFETY CONTRACT:
//   - The service worker caches ONLY the static app shell (fingerprinted JS/CSS
//     + icons + a 3s-timeout NetworkFirst copy of the HTML doc). It is NOT a
//     data layer — `/api/*` and `/ws/*` are never intercepted, so the bearer
//     gate + WS first-frame auth run exactly as without a SW.
//   - The auth token lives on `window._SUPERMUX_AUTH_TOKEN` (never localStorage,
//     never in the SW source). It only ever appears inside the freshly fetched
//     HTML doc; on token rotation Settings drops the `supermux-html` cache so no
//     stale doc can serve an old token.

import { registerSW } from 'virtual:pwa-register'
import { injectIOSSplashLinks } from '@/lib/ios-splash'
import { installControllerChangeReload, markWaiting } from '@/lib/sw-update'
import { startVersionGuard } from '@/lib/version-guard'

// How often a long-open PWA re-checks the server for a freshly deployed shell.
// The browser only polls the SW script on navigation / roughly daily on its
// own, so without this a home-screen app can sit on a stale bundle for hours
// after a deploy. 60s is cheap (one conditional GET of sw.js, 304 when nothing
// changed) and makes "deployed" reach "waiting" within a minute.
const SW_UPDATE_POLL_MS = 60_000

/**
 * Wire up the PWA: register the service worker (auto-updating) and add the iOS
 * launch-splash links. Safe to call unconditionally — guarded internally.
 */
export function initPWA(): void {
  // iOS launch-splash links — runs on iOS only (see ios-splash.ts).
  injectIOSSplashLinks()

  // Served-version heartbeat — the SW-lifecycle-INDEPENDENT update guard. Runs
  // only in a production build (in dev the page is Vite-served, not the embedded
  // server bundle, so a sha "mismatch" is meaningless) and even when a service
  // worker is missing, so a bundle wedged on an ancient SW that can never fire
  // `onNeedRefresh` still surfaces the reload bar. See lib/version-guard.ts.
  if (import.meta.env.PROD) startVersionGuard()

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // Land the page on the fresh bundle the moment the new SW takes over. With
  // skipWaiting+clientsClaim (vite.config.ts) the new worker activates and
  // claims this page on its own — iOS standalone never delivered the waiting-SW
  // tap that `prompt` mode would otherwise wait on. This turns that takeover's
  // one `controllerchange` into a DRAFT-GUARDED reload (idle → reload; unsent
  // draft / visible tab → surface the one-tap bar instead). Installed before
  // registerSW so the controller snapshot is taken before this load can be
  // claimed. See installControllerChangeReload in lib/sw-update.ts.
  installControllerChangeReload()

  // `prompt` registration (see the `registerType` comment in vite.config.ts):
  // `autoUpdate` reloads the document out from under the user on every
  // activation — the measured data-loss bug — so we stay on `prompt`, which
  // leaves the freshly deployed shell WAITING and reloads NOTHING on its own.
  //
  // What USED to be missing: `onNeedRefresh` was a no-op, so that waiting worker
  // sat there until every tab closed (never, for a home-screen PWA) and the
  // deploy never reached the client. Now `onNeedRefresh` hands the adoption
  // thunk (`updateSW(true)` = skipWaiting + reload onto the new bundle) to the
  // idle-guarded adoption store: it reloads silently when the app is idle,
  // otherwise surfaces a one-tap "Reload to update" button. Either way the new
  // bundle is adopted and the "waiting" hint resolves — no draft is lost,
  // because the idle-guard vetoes an auto-reload while the composer holds unsent
  // text and the button is a deliberate user tap.
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      markWaiting(() => {
        void updateSW(true)
      })
    },
    onRegisteredSW(_url, registration) {
      // Token-rotation invalidation: Settings → Rotate token
      // posts `{type:'token-rotated'}` to the controlling SW. The SW has no
      // custom message handler in the generated Workbox build, so the cache
      // drop happens here in the page (caches.delete is page-accessible) and
      // we additionally nudge the SW to re-check for an updated shell.
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'token-rotated') {
          void caches?.delete?.('supermux-html')
          void registration?.update?.()
        }
      })

      // Actively poll for a new shell so a deploy reaches a long-open PWA within
      // ~a minute instead of whenever the browser next feels like checking. Also
      // check the instant the tab is brought to the foreground — the common way
      // a phone PWA comes back after a deploy happened while it was backgrounded.
      if (!registration) return
      const check = () => void registration.update?.()
      window.setInterval(check, SW_UPDATE_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })
}
