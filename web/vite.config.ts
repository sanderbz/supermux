import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
// Tailwind v4 is wired via the first-party Vite plugin (TECH_PLAN §M0 / §4) —
// no postcss.config.js / tailwind.config.ts pipeline required.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // M23b (TECH_PLAN §4.9 / §10): installable PWA for iOS Safari.
    //
    // The service worker caches ONLY the static app shell (fingerprinted JS/CSS
    // + icons). It is NOT a data layer: the WebSocket (live terminal) and SSE
    // (metadata) remain the single source of truth for session data. There is
    // NO polling and NO offline data replay here.
    //
    // Auth-safety contract (Codex #13/#20):
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
      registerType: 'autoUpdate',
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
      ],
      manifest: {
        name: 'supermux',
        short_name: 'supermux',
        description: 'Run and watch your agents from anywhere.',
        // ?source=pwa lets the app distinguish a home-screen launch (§4.9).
        start_url: '/?source=pwa',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Matches globals.css --background and the dark first-frame paint, so
        // the iOS splash has NO flash of white (M23b acceptance).
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
        cleanupOutdatedCaches: true,
        // Single-page-app fallback: an unknown navigation re-serves index.html…
        navigateFallback: '/index.html',
        // …EXCEPT for /api and /ws — those must always hit the live backend so
        // the bearer gate + WS first-frame auth run unchanged (Codex #13/#20).
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        runtimeCaching: [
          {
            // The HTML document carries the auth token — NetworkFirst with a
            // 3s timeout means a live token always wins; the cache is only a
            // brief offline-shell fallback. Cache name `supermux-html` is the one
            // Settings → Rotate token drops on rotation (M22 contract).
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' &&
              !url.pathname.startsWith('/api/') &&
              !url.pathname.startsWith('/ws/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supermux-html',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 },
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
    // M29 (TECH_PLAN §10): explicit vendor splitting so the hero loop
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
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 5173,
    // Backend (Rust/axum) runs on 127.0.0.1:8823 in dev. The M24a e2e smoke
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
