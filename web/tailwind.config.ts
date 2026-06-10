import type { Config } from 'tailwindcss'

// Tailwind v4 is configured CSS-first via `@theme` in src/styles/globals.css and
// wired through the @tailwindcss/vite plugin (see vite.config.ts) — it does NOT
// auto-load this file. It exists only to declare content sources for any
// tooling that still expects a JS/TS config.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
} satisfies Config
