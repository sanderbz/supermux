import { defineConfig } from '@playwright/test'

// Screenshot capture for the snippets editing/visibility PR. Uses the smoke
// harness pattern: each test boots a REAL supermux-server binary + a Vite dev
// server (see tests/e2e/smoke/harness.ts), so the app runs live (real SSE/WS +
// real /api/snippets) instead of fighting hermetic mocks. No global webServer —
// the harness owns the lifecycle.
//   Run: SUPERMUX_E2E_NO_SANDBOX=1 bunx playwright test -c playwright.screens.config.ts
export default defineConfig({
  testDir: './tests/e2e/screens',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--single-process',
        '--disable-dev-shm-usage',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
