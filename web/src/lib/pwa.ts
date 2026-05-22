// PWA boot wiring — M23b (TECH_PLAN §4.9 / §10).
//
// Registers the vite-plugin-pwa service worker and injects the iOS launch-
// splash <link> tags. Called once from main.tsx. Everything here is a no-op in
// environments without a service worker (dev, SSR, old browsers).
//
// SAFETY CONTRACT (Codex #13/#20):
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

/**
 * Wire up the PWA: register the service worker (auto-updating) and add the iOS
 * launch-splash links. Safe to call unconditionally — guarded internally.
 */
export function initPWA(): void {
  // iOS launch-splash links — runs on iOS only (see ios-splash.ts).
  injectIOSSplashLinks()

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  // `autoUpdate` registration: a new shell is fetched + activated in the
  // background; `onNeedRefresh` is intentionally a no-op (we never block the
  // running session on a reload — the next cold launch picks it up).
  registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      // Token-rotation invalidation (M22 contract): Settings → Rotate token
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
    },
  })
}
