import { defineConfig, devices } from '@playwright/test'

// Mobile action-panels spec (unified sheets + quick-keys). Unlike the smoke
// suite (which boots a real Rust binary + tmux per test), this config serves the
// built static app via `vite preview` and stubs ALL backend traffic (REST + SSE
// + the live-terminal WebSocket) at the network layer with Playwright route
// mocking. That keeps the test hermetic + fast while still exercising the REAL
// app code: it asserts the actual WS `{type:'input'}` bytes a chip tap sends and
// the real `/api/prefs/quick_keys` PUT an Edit toggle persists.
//
// Run: `bun run build` first (this serves dist), then
//   bunx playwright test -c playwright.mobile.config.ts
export default defineConfig({
  testDir: './tests/e2e/mobile',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  webServer: {
    command: 'bunx vite preview --port 4317 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The built app registers a PWA service worker (sw.js) that intercepts fetch
    // and can shadow Playwright's network route mocking (notably for PUT). Block
    // it so `page.route` sees every request deterministically.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'iphone',
      // iPhone 14 Pro Max ≈ 430×932, iOS Safari UA — the mobile focus surface.
      use: {
        ...devices['iPhone 14 Pro Max'],
        browserName: 'webkit',
      },
    },
  ],
})
