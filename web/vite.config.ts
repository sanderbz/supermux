import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// Tailwind v4 is wired via the first-party Vite plugin (TECH_PLAN §M0 / §4) —
// no postcss.config.js / tailwind.config.ts pipeline required.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Backend (Rust/axum) runs on 127.0.0.1:8823 in dev; later milestones
    // proxy /api and /ws here. Left unset in M0 (no API calls yet).
  },
})
