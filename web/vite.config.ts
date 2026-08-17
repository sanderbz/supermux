import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Tailwind v4 is wired via the first-party Vite plugin —
// no postcss.config.js / tailwind.config.ts pipeline required.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Installable PWA for iOS Safari.
    //
    // The service worker caches ONLY the static app shell (fingerprinted JS/CSS
    // + icons). It is NOT a data layer: the WebSocket (live terminal) and SSE
    // (metadata) remain the single source of truth for session data. There is
    // NO polling and NO offline data replay here.
    //
    // Auth-safety contract (what the service worker must never break):
    //   - `/` (the HTML doc) is fetched NetworkFirst with a 3s timeout. The doc
    //     carries the injected `window._SUPERMUX_AUTH_TOKEN`, so a stale cached doc
    //     would leak an old token — NetworkFirst keeps the cache as a 3s-timeout
    //     fallback only, and the entry is dropped on token rotation (Settings →
    //     Rotate token posts `{type:'token-rotated'}`, see sw-token-guard.ts).
    //   - `/api/*` and `/ws/*` are NEVER intercepted (navigateFallbackDenylist
    //     + a runtime no-op): every request hits the network and is bearer-gated
    //     by the backend exactly as without a SW. The SW never bypasses auth.
    //   - `manifest.webmanifest` + icons are public assets (the documented
    //     public router exceptions) — precached, not bearer-gated.
    VitePWA({
      // `prompt`, NOT `autoUpdate` — and the difference is a data-loss bug.
      //
      // `autoUpdate` makes vite-plugin-pwa's registration reload the DOCUMENT on
      // any service-worker activation or external takeover
      // (`wb.addEventListener('activated', e => (e.isUpdate || e.isExternal) &&
      // location.reload())`). That is an unrequested reload of a page whose
      // composer, terminal draft and scroll position are all in memory: a
      // harness run measured 31 typed characters destroyed by one, with SW
      // `controllerchange` immediately preceding `beforeunload`.
      //
      // `prompt` leaves the new shell WAITING instead. Nothing reloads under the
      // user; the update lands on the next cold launch — which is exactly what
      // `lib/pwa.ts` has always claimed this registration does — and the server
      // updater's own "Reload now" button (settings/updates-panel.tsx) is still
      // the deliberate, user-pressed path to it.
      //
      // (The composer's drafts are ALSO persisted now, `chat/composer-draft.ts`
      // — belt to this brace, because a reload can arrive from a crash, a
      // pull-to-refresh or the user's own ⌘R too.)
      registerType: 'prompt',
      // public/manifest.json stays for the <link rel="manifest"> in index.html;
      // the generated `manifest.webmanifest` is the SW-precached canonical copy.
      manifestFilename: 'manifest.webmanifest',
      includeAssets: [
        'favicon.svg',
        'icon.svg',
        'icon-192.png',
        'icon-512.png',
        'apple-touch-icon.png',
        'splash/*.png',
        // Branded offline shell, precached so the SW can serve it on the
        // cold-start-with-no-server path (first visit while offline). See
        // workbox.runtimeCaching below for the navigation-fallback wiring.
        'offline.html',
      ],
      manifest: {
        name: 'supermux',
        short_name: 'supermux',
        description: 'Run and watch your agents from anywhere.',
        // ?source=pwa lets the app distinguish a home-screen launch.
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Matches globals.css --background and the dark first-frame paint, so
        // the iOS splash has NO flash of white.
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the fingerprinted shell assets (JS/CSS/icons). These are
        // content-hashed, so CacheFirst is safe and `cleanupOutdatedCaches`
        // sweeps superseded revisions on every SW activation.
        globPatterns: ['**/*.{js,css,svg,png,woff2}'],
        // …but NOT the two full Nerd Font faces. They are 935 KB each and are
        // `unicode-range`-scoped in globals.css to PUA icon glyphs, so the app
        // is fully usable without them (the 86 KB `-core` subsets ARE precached
        // and cover all terminal text plus Powerline). Precaching them made
        // every first visit — including a phone on 3G that never opens a
        // terminal — pay 1.87 MB before the SW would activate.
        globIgnores: ['fonts/JetBrainsMonoNerdFontMono-{Regular,Bold}.woff2'],
        // PUSH: import the hand-written push/notificationclick handlers into the
        // generated SW. This ADDS listeners without switching to injectManifest,
        // so the offline-shell precaching behaviour is left untouched. The path
        // is root-relative — push-sw.js is a public asset served at /push-sw.js.
        importScripts: ['/push-sw.js'],
        cleanupOutdatedCaches: true,
        // No navigateFallback: the server returns index.html for every SPA
        // route, so the NetworkFirst rule below handles all navigations.
        // `navigateFallback: '/index.html'` would require index.html to be in
        // the precache manifest (globPatterns only covers hashed assets, not
        // HTML), which throws `non-precached-url` on slow connections when the
        // 3s NetworkFirst timeout fires before the network responds.
        //
        // `null`, not "omitted": generateSW DEFAULTS navigateFallback to
        // 'index.html', and the paragraph above was a comment describing a
        // setting nobody made. The shipped sw.js really did carry
        //   registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")))
        // while the only HTML in the manifest was offline.html — the exact
        // hazard, live. Because that precache route is registered FIRST it also
        // shadowed the NetworkFirst rule, so `supermux-html` was never created
        // and the branded offline shell was unreachable dead code.
        // `sw-navigation-route.test.ts` greps the built sw.js so this cannot
        // silently come back on a plugin bump.
        navigateFallback: null,
        runtimeCaching: [
          {
            // The HTML document carries the auth token — NetworkFirst with a
            // 3s timeout means a live token always wins; the cache is only a
            // brief offline-shell fallback. Cache name `supermux-html` is the one
            // Settings → Rotate token drops on rotation.
            //
            // When BOTH the network and the cached HTML doc fail (cold
            // first-visit while offline / server down), Workbox tries
            // `precache(offline.html)` — that file is precached above so it's
            // guaranteed to be available. The user gets a branded
            // "Couldn't reach the supermux server" page instead of the
            // browser's generic "site can't be reached" chrome.
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' &&
              !url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/ws/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supermux-html',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 },
              precacheFallback: { fallbackURL: '/offline.html' },
            },
          },
          {
            // Fingerprinted JS/CSS — immutable, CacheFirst forever.
            urlPattern: ({ request }) =>
              request.destination === 'script' || request.destination === 'style',
            handler: 'CacheFirst',
            options: {
              cacheName: 'supermux-assets',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        // Keep the SW out of the dev server so HMR is unaffected; it is
        // exercised by `bun run build` + `bun run preview` instead.
        enabled: false,
      },
    }),
  ],
  resolve: {
    // @/* → src/* (shadcn copy-source convention; mirrors tsconfig paths).
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Explicit vendor splitting so the hero loop
    // (overview + focus terminal) ships a lean main `app` chunk and heavy
    // vendors are cached / loaded independently. Budgets are enforced
    // post-build by `scripts/size-budget.mjs` (`bun run perf:size`).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'vendor-react'
          if (/[\\/]node_modules[\\/]@xterm[\\/]/.test(id)) return 'vendor-xterm'
          if (/[\\/]node_modules[\\/]framer-motion[\\/]/.test(id)) return 'vendor-framer'
          if (/[\\/]node_modules[\\/](@codemirror|@uiw|@lezer|codemirror)[\\/]/.test(id))
            return 'vendor-codemirror'
          // Rendered-markdown stack — unified/remark/rehype/mdast/hast/
          // micromark/lowlight/highlight.js plus react-markdown itself. Lazy
          // route only (FileViewer markdown Preview tab), so split it out so
          // the overview/focus hero loop never pays for it.
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-[^/\\]+|rehype-[^/\\]+|unified|unist-[^/\\]+|mdast-[^/\\]+|micromark[^/\\]*|hast-[^/\\]+|lowlight|highlight\.js|character-entities[^/\\]*|decode-named-character-reference|ccount|escape-string-regexp|trim-lines|space-separated-tokens|comma-separated-tokens|property-information|html-url-attributes|html-void-elements|web-namespaces|zwitch|trough|vfile[^/\\]*|bail|is-plain-obj|extend|devlop|fault)[\\/]/.test(id)
          )
            return 'vendor-markdown'
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    // Backend (Rust/axum) runs on 127.0.0.1:8823 in dev. The e2e smoke
    // harness boots a fresh binary on an ephemeral port and points Vite at it
    // via SUPERMUX_E2E_BACKEND, so /api + /ws are proxied SAME-ORIGIN — the app runs
    // exactly as it does behind the embedded static server (no CORS, no
    // cross-origin WS), and `window._SUPERMUX_BASE_URL` can stay relative.
    proxy: process.env.SUPERMUX_E2E_BACKEND
      ? {
          '/api': { target: process.env.SUPERMUX_E2E_BACKEND, changeOrigin: true },
          '/ws': { target: process.env.SUPERMUX_E2E_BACKEND, ws: true, changeOrigin: true },
        }
      : undefined,
  },
})
