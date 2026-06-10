import { defineConfig } from '@playwright/test'

// Smoke e2e — the FOUR most-critical
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
    // Chrome's own sandbox + multiprocess zygote can't initialize on a hardened
    // host (NoNewPrivileges + restricted namespaces/seccomp — e.g. running inside
    // the supermux systemd service): child processes die with
    // `credentials.cc Operation not permitted` and the GPU process crash-loops.
    // Opt into a single-process, no-sandbox, no-GPU launch via env for those
    // runners (the self-host box, a CI container). Default keeps the full sandbox
    // ON for normal dev/CI where it works.
    launchOptions: process.env.SUPERMUX_E2E_NO_SANDBOX
      ? {
          args: [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--no-zygote',
            '--single-process',
            '--disable-dev-shm-usage',
          ],
        }
      : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    // Opt-in WebKit project — the closest proxy to iOS Safari / WKWebView, the
    // platform the mobile touch-scroll specs actually target. Off by default so
    // CI (and machines without the WebKit build) stay chromium-only and green;
    // enable with `SUPERMUX_E2E_WEBKIT=1 npx playwright test --project=webkit`
    // (needs `npx playwright install webkit`). The mobile specs build touch
    // events cross-engine via `touchDragY` in harness.ts, so they run on both.
    ...(process.env.SUPERMUX_E2E_WEBKIT
      ? [{ name: 'webkit', use: { browserName: 'webkit' as const } }]
      : []),
  ],
})
