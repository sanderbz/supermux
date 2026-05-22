import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Tailwind v4 is wired via the first-party Vite plugin (TECH_PLAN §M0 / §4) —
// no postcss.config.js / tailwind.config.ts pipeline required.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    // via AMUX_E2E_BACKEND, so /api + /ws are proxied SAME-ORIGIN — the app runs
    // exactly as it does behind the embedded static server (no CORS, no
    // cross-origin WS), and `window._AMUX_BASE_URL` can stay relative.
    proxy: process.env.AMUX_E2E_BACKEND
      ? {
          '/api': { target: process.env.AMUX_E2E_BACKEND, changeOrigin: true },
          '/ws': { target: process.env.AMUX_E2E_BACKEND, ws: true, changeOrigin: true },
        }
      : undefined,
  },
})
