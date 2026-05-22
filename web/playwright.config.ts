import { defineConfig } from '@playwright/test'

// M24a — smoke e2e (TECH_PLAN §7.2, §10 "M24a"). The FOUR most-critical
// early-warning tests, run against a REAL supermux-server binary booted per-test on
// an ephemeral port with an isolated temp data dir (see tests/e2e/smoke/harness.ts).
//
// No global webServer: each spec boots its own backend + Vite dev server through
// the harness so a backend-kill/restart test (ws-reconnect) can drive the
// process lifecycle directly. Vite proxies /api + /ws to the backend SAME-ORIGIN
// (vite.config.ts reads SUPERMUX_E2E_BACKEND), so the app runs exactly as it does
// behind the embedded static server — no CORS, no cross-origin WebSocket.
export default defineConfig({
  testDir: './tests/e2e/smoke',
  // Serial: each test owns a tmux-backed binary + dev server; running them in
  // parallel would multiply port/tmux pressure on a dev laptop for no real gain
  // on a 4-test suite. CI can still shard by spec file.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Generous: booting a Rust binary + Vite + tmux pane settle dominates.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
