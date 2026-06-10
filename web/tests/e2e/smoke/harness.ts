// Smoke-e2e harness. Boots a REAL supermux-server binary on an
// ephemeral port with an isolated temp data dir, plus a Vite dev server that
// proxies /api + /ws to it SAME-ORIGIN. Each test gets a clean backend, so a
// kill/restart test can drive the process lifecycle directly.
//
// Isolation: SUPERMUX_DATA_DIR points at a fresh temp dir (server/src/config.rs
// honours it) so a run never touches the real ~/.supermux. SUPERMUX_AUTH_TOKEN is a
// fixed per-run token we hand to the page via window._SUPERMUX_AUTH_TOKEN. SUPERMUX_BIND
// pins the chosen free port.

import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
// web/tests/e2e/smoke → repo root → server/target/{release,debug}/supermux-server
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const WEB_DIR = resolve(__dirname, '..', '..', '..')

export interface Backend {
  /** Base origin of the Vite dev server the browser navigates to. */
  baseUrl: string
  /** Dashboard bearer token to inject as window._SUPERMUX_AUTH_TOKEN. */
  token: string
  /** Direct backend origin (http://127.0.0.1:<port>) — for `request` probes. */
  backendUrl: string
  backendPort: number
  vitePort: number
  /** Temp data dir (SUPERMUX_DATA_DIR) for this backend. */
  dataDir: string
  /** Stop the binary (SIGTERM); resolves once it exits. */
  killBackend(): Promise<void>
  /** Boot a fresh binary on the SAME port + data dir (reconnect test). */
  restartBackend(): Promise<void>
  /** Tear down backend + vite + temp dir. */
  dispose(): Promise<void>
}

/** Locate the built binary, preferring release. Throws a helpful error if absent. */
export function binaryPath(): string {
  const candidates = [
    join(REPO_ROOT, 'server', 'target', 'release', 'supermux-server'),
    join(REPO_ROOT, 'server', 'target', 'debug', 'supermux-server'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    throw new Error(
      `supermux-server binary not found. Build it first:\n  (cd server && cargo build)\nlooked in:\n  ${candidates.join('\n  ')}`,
    )
  }
  return found
}

/** Reserve a free TCP port by binding to :0, then releasing it. */
export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => res(port))
      } else {
        srv.close(() => rej(new Error('could not resolve free port')))
      }
    })
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll GET <url>/api/health until it returns 200 (or timeout). */
async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch (e) {
      lastErr = e
    }
    await sleep(150)
  }
  throw new Error(`backend health never became ready at ${url}: ${String(lastErr)}`)
}

/** Poll an arbitrary URL until it responds (any status) — used for Vite readiness. */
async function waitForUp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      lastErr = e
    }
    await sleep(200)
  }
  throw new Error(`server never came up at ${url}: ${String(lastErr)}`)
}

function spawnBackend(opts: {
  bin: string
  port: number
  dataDir: string
  token: string
}): ChildProcess {
  const child = spawn(opts.bin, [], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPERMUX_DATA_DIR: opts.dataDir,
      SUPERMUX_BIND: `127.0.0.1:${opts.port}`,
      SUPERMUX_AUTH_TOKEN: opts.token,
      RUST_LOG: process.env.RUST_LOG ?? 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  return child
}

function killProc(child: ChildProcess | null): Promise<void> {
  return new Promise((res) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      res()
      return
    }
    const onExit = () => res()
    child.once('exit', onExit)
    try {
      child.kill('SIGTERM')
    } catch {
      res()
      return
    }
    // Hard-kill backstop after 5s.
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      res()
    }, 5_000)
  })
}

/**
 * Boot a backend binary + a Vite dev server proxied to it. Returns a {@link Backend}
 * the test drives. Call `dispose()` in `afterEach`/`finally`.
 */
export async function startBackend(): Promise<Backend> {
  const bin = binaryPath()
  const backendPort = await freePort()
  const vitePort = await freePort()
  const token = `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}`
  const dataDir = mkdtempSync(join(tmpdir(), 'supermux-e2e-'))
  const backendUrl = `http://127.0.0.1:${backendPort}`
  const baseUrl = `http://127.0.0.1:${vitePort}`

  let backend: ChildProcess | null = spawnBackend({
    bin,
    port: backendPort,
    dataDir,
    token,
  })
  await waitForHealth(backendUrl)

  // Vite dev server: SUPERMUX_E2E_BACKEND makes vite.config.ts proxy /api + /ws to
  // the backend, so the app talks SAME-ORIGIN (no CORS / cross-origin WS).
  const vite: ChildProcess = spawn(
    'bunx',
    ['vite', '--port', String(vitePort), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: WEB_DIR,
      env: { ...process.env, SUPERMUX_E2E_BACKEND: backendUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  vite.stdout?.on('data', () => {})
  vite.stderr?.on('data', () => {})
  await waitForUp(baseUrl)

  return {
    baseUrl,
    token,
    backendUrl,
    backendPort,
    vitePort,
    dataDir,
    async killBackend() {
      await killProc(backend)
      backend = null
    },
    async restartBackend() {
      if (backend) await killProc(backend)
      backend = spawnBackend({ bin, port: backendPort, dataDir, token })
      await waitForHealth(backendUrl, 30_000)
    },
    async dispose() {
      await killProc(backend)
      backend = null
      await killProc(vite)
      try {
        rmSync(dataDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    },
  }
}

/**
 * Inject the runtime config the server normally writes into index.html as
 * `window._SUPERMUX_*` globals (env.ts). Base + WS stay relative (same-origin Vite,
 * proxied to the backend); only the token must be supplied. MUST be called via
 * `page.addInitScript` BEFORE the first navigation so it's set before main.tsx.
 */
export function injectGlobals(token: string): string {
  return `
    window._SUPERMUX_AUTH_TOKEN = ${JSON.stringify(token)};
    // Base + WS default to same-origin in env.ts; leave them unset so requests
    // hit the Vite dev server, which proxies to the backend.
    window._SUPERMUX_VERSION = 'e2e';
  `
}

/** A small helper around the backend REST API for tests that need to seed/probe
 *  state directly (create a shell session, create a board issue). Uses the direct
 *  backend origin so it's independent of the page/proxy. */
export function api(backend: Backend) {
  const h = (extra?: Record<string, string>): Record<string, string> => ({
    Authorization: `Bearer ${backend.token}`,
    'Content-Type': 'application/json',
    ...extra,
  })
  return {
    async health(): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/health`)
    },
    async createSession(body: Record<string, unknown>): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/sessions`, {
        method: 'POST',
        headers: h(),
        body: JSON.stringify(body),
      })
    },
    async startSession(name: string): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/sessions/${encodeURIComponent(name)}/start`, {
        method: 'POST',
        headers: h(),
        body: '{}',
      })
    },
    async listSessions(): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/sessions`, { headers: h() })
    },
    /** `GET /api/sessions/{name}/peek` — the captured pane text (renderer-agnostic
     *  read of what the live terminal shows; the CanvasAddon means xterm paints to
     *  <canvas> with no readable DOM text, so we verify pty output server-side). */
    async peek(name: string, lines = 40): Promise<string> {
      const res = await fetch(
        `${backend.backendUrl}/api/sessions/${encodeURIComponent(name)}/peek?lines=${lines}`,
        { headers: h() },
      )
      if (!res.ok) return ''
      const body = await res.json()
      return typeof body?.data === 'string' ? body.data : ''
    },
    async createIssue(body: Record<string, unknown>): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/board`, {
        method: 'POST',
        headers: h(),
        body: JSON.stringify(body),
      })
    },
    async claim(id: string, session: string): Promise<Response> {
      return fetch(`${backend.backendUrl}/api/board/${encodeURIComponent(id)}/claim`, {
        method: 'POST',
        headers: h(),
        body: JSON.stringify({ session }),
      })
    },
  }
}

/**
 * Dispatch a REAL one-finger vertical touch-drag of `totalPx` pixels (positive =
 * finger DOWN = reveal history → scrollTop decreases) over `steps` `touchmove`s
 * on `selector`, then return `.xterm-viewport` scrollTop before/after.
 *
 * CROSS-ENGINE. Blink honours `new TouchEvent({ touches: [new Touch(...)] })`,
 * but WebKit silently drops the `touches` sequence (length 0 in the listener),
 * so on WebKit the shim's `e.touches.length === 1` gate could never fire from a
 * synthetic event. WebKit needs the legacy `document.createTouch` +
 * `document.createTouchList` construction. We probe once which one actually
 * populates `e.touches` in THIS engine and use it — so the same spec exercises
 * the touch-scroll path on BOTH chromium and webkit. `method` is returned for
 * diagnostics.
 */
export async function touchDragY(
  page: Page,
  selector: string,
  totalPx: number,
  steps = 16,
): Promise<{ before: number; after: number; method: string }> {
  return page.evaluate(
    async ({ selector, totalPx, steps }) => {
      const screen = document.querySelector(selector) as HTMLElement
      const vp = document.querySelector('.xterm-viewport') as HTMLElement
      const r = screen.getBoundingClientRect()
      const x = r.left + r.width / 2
      const startY = r.top + r.height * 0.3
      const d = document as unknown as {
        createTouch: (...a: unknown[]) => Touch
        createTouchList: (...t: Touch[]) => TouchList
      }
      // Does `new TouchEvent({touches:[Touch]})` actually populate e.touches here?
      // True on Blink, false on WebKit.
      const ctorWorks = (() => {
        try {
          const t = new Touch({
            identifier: 1, target: screen, clientX: 0, clientY: 0,
            pageX: 0, pageY: 0, screenX: 0, screenY: 0,
            radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1,
          })
          return new TouchEvent('touchstart', { touches: [t] }).touches.length === 1
        } catch {
          return false
        }
      })()
      const method = ctorWorks ? 'ctor' : 'createTouch'
      const mkTouch = (py: number): Touch =>
        ctorWorks
          ? new Touch({
              identifier: 1, target: screen, clientX: x, clientY: py,
              pageX: x, pageY: py, screenX: x, screenY: py,
              radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1,
            })
          : d.createTouch(window, screen, 1, x, py, x, py)
      const mkList = (touches: Touch[]): TouchList | Touch[] =>
        ctorWorks ? touches : d.createTouchList(...touches)
      const fire = (type: string, py: number) => {
        const t = mkTouch(py)
        const live = type === 'touchend' ? mkList([]) : mkList([t])
        screen.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: live as TouchList,
            targetTouches: live as TouchList,
            changedTouches: mkList([t]) as TouchList,
          }),
        )
      }
      const before = vp.scrollTop
      fire('touchstart', startY)
      const step = totalPx / steps
      for (let i = 1; i <= steps; i++) {
        fire('touchmove', startY + step * i)
        await new Promise((res) => setTimeout(res, 10))
      }
      fire('touchend', startY + totalPx)
      await new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(() => res(null))),
      )
      return { before, after: vp.scrollTop, method }
    },
    { selector, totalPx, steps },
  )
}
