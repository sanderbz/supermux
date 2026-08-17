// Chromium launch args for hosts where Chrome's own sandbox + multiprocess
// zygote can't initialize (NoNewPrivileges + restricted namespaces/seccomp —
// e.g. running inside the supermux systemd service, or a CI container).
// Symptom without these: child processes die with
// `credentials.cc Operation not permitted` and the GPU process crash-loops.
//
// WHY NO `--single-process` (INFRA-01):
//   `--single-process` collapses browser + renderer into one OS process, so
//   tearing down a BrowserContext tears down the browser itself. Playwright
//   shares ONE browser across the tests in a worker, so every context close
//   killed it: the NEXT test's `page` fixture failed with
//   "Target page, context or browser has been closed", Playwright then
//   relaunched, and the test after that passed. Net effect on a 9-test file:
//   tests 2, 4, 6, 8 red, 1, 3, 5, 7, 9 green — which is why multi-test spec
//   files and second contexts were believed impossible on this host and specs
//   were written as one giant test / run one file at a time.
//   `--no-zygote` alone is what actually makes the hardened host work; it keeps
//   the multi-process architecture (browser process survives context teardown)
//   while skipping the zygote that cannot fork here. Verified: 9/9 including a
//   `browser.newContext()` in the middle of a spec file.
export const HARDENED_HOST_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-zygote',
  '--disable-dev-shm-usage',
]
