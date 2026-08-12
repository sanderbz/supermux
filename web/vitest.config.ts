import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// Unit tests only (the browser flows live in tests/e2e, run by Playwright).
// Deliberately does NOT extend vite.config.ts: the app config carries the React,
// Tailwind and PWA plugins, none of which the pure data-layer tests need.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
