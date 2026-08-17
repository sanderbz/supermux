// The chat data plane, as a test fixture (fase A6 T3).
//
// THE PROBLEM THIS SOLVES. The five reconnect specs have to assert CONTENT —
// "entry 7 is on screen exactly once" — across a backend restart, a redial and
// a re-seed. That needs a transcript the test owns byte for byte. A real
// `claude` cannot provide one here: the e2e isolates `$CLAUDE_CONFIG_DIR`
// (or `bun run test:e2e:smoke` would rewrite the developer's own
// `~/.claude/settings.json`), an isolated config dir has no credentials, and a
// Claude that is sitting on a login screen never writes a transcript, never
// fires `SessionStart`, and never sets the conversation pointer.
//
// THE SHAPE OF THE FIXTURE. Everything the specs exercise is the REAL server:
// the tailer's `notify` watcher, its byte cursor, `classify_pointer`, the WS
// seed/live boundary, the `seq` dedupe, the resync epoch, the close codes.
// Only two things are stand-ins, and both are things the server treats as
// opaque input:
//
//   1. THE PANE. `provider: 'claude'` is required by `chat_eligible`
//      (`server/src/sessions/chat/ws.rs:97`) and by the client's own
//      `chatEligible` guard, and the focus seam refuses to render chat for a
//      `stopped` session — so the session has to be a running claude-provider
//      session. `flags` is interpolated into the launch line
//      (`sessions/lifecycle.rs:388-394`), so we use it to run a bare `bash`
//      instead of the agent. The pane is then a live pty that stays up and
//      writes nothing, which is exactly the blank canvas the transcript
//      assertions need. This is a TEST FIXTURE, not a supported configuration.
//
//   2. THE TRANSCRIPT. The test writes `<project>/<conv>.jsonl` itself, in the
//      same JSONL shape `server/tests/chat_ws.rs` uses, and the tailer reads it
//      the way it reads Claude's own. Appending a line IS the event.
//
// The conversation pointer and `hooks_live` are set through the REAL hook
// endpoint (`POST /api/_internal/hook`), authenticated with the session's real
// per-session `$SUPERMUX_HOOK_TOKEN` — which the pane writes out for us,
// because that is the only place it exists (it is deliberately never written
// into the world-shared `settings.json`, see `claude_config.rs:27`). Without a
// hook, `classify_pointer` reports `Reconnecting { "no hook since start" }` for
// a RUNNING session, so this is not a shortcut: it is the same signal a real
// Claude sends, and the specs depend on the difference.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, type Page } from '@playwright/test'

import { api, type Backend } from './harness'

// Module scope: runs before any `beforeEach`/`startBackend` in a spec that
// imports this file. The backend inherits `process.env`, and its hook installer
// writes into `$CLAUDE_CONFIG_DIR/settings.json` — never the developer's own.
process.env.CLAUDE_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'a6t3-claude-cfg-'))

/** zustand persist payload for the UI store with the chat renderer ON. */
export const CHAT_FLAG_ON = JSON.stringify({ state: { chatRenderer: true }, version: 0 })

/** `~/.claude/projects/<encoded cwd>/` — `resumable::project_dir_for`'s encoding
 *  (`/` and `.` both become `-`), against the CANONICAL path, because that is
 *  what the server resolves. */
function projectDir(workDir: string): string {
  const resolved = realpathSync(workDir)
  const encoded = resolved.replace(/[/.]/g, '-')
  return join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', encoded)
}

/** One JSONL line the chat parser turns into exactly one `prompt` entry. */
function line(conv: string, uuid: string, text: string, tsMs: number): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: new Date(tsMs).toISOString(),
    sessionId: conv,
    message: { role: 'user', content: text },
  })
}

export interface ChatFixture {
  /** Session slug. */
  name: string
  /** The session's working dir (its Claude project dir is derived from it). */
  workDir: string
  /** Replace a conversation file wholesale. A LENGTH GOING BACKWARDS is what
   *  the tailer reads as a rotation, so this is also how a spec forces a
   *  re-seed without moving the pointer. */
  write(conv: string, texts: readonly string[]): void
  /** Append lines — the live path. */
  append(conv: string, texts: readonly string[]): void
  /** Fire a real hook event. `conv` moves the conversation pointer
   *  (`SessionStart` carries `session_id`); omitting it just proves the hooks
   *  are alive, which is what `classify_pointer` needs to say `Live`. */
  hook(conv?: string): Promise<void>
}

/**
 * Create + start a chat-eligible session whose pane is a shell, and hand back
 * the handles a reconnect spec needs. Never returns until the pane has written
 * its hook token, so `hook()` is usable immediately.
 */
export async function chatSession(backend: Backend, name: string): Promise<ChatFixture> {
  const workDir = join(backend.dataDir, `work-${name}`)
  mkdirSync(workDir, { recursive: true })
  const tokenFile = join(workDir, '.hook-token')

  // `--version` makes a real `claude` on the runner's PATH exit immediately
  // instead of taking over the pane; a missing one is a harmless
  // "command not found". The trailing `#` comments out the `--name <session>`
  // the launch builder appends after our flags.
  const flags =
    `--version >/dev/null 2>&1; printf %s "$SUPERMUX_HOOK_TOKEN" > ${tokenFile}; ` +
    `exec env PS1='t3$ ' bash --norc --noprofile -i #`

  const created = await api(backend).createSession({ name, provider: 'claude', dir: workDir, flags })
  expect([200, 201]).toContain(created.status)
  expect((await api(backend).startSession(name)).ok).toBeTruthy()

  // The pane writes the token as its first act. Every `start` mints a FRESH
  // token (`lifecycle.rs:7`), so this must be read after the start, never before.
  const deadline = Date.now() + 20_000
  while (!existsSync(tokenFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!existsSync(tokenFile)) throw new Error(`pane never wrote ${tokenFile}`)
  const hookToken = readFileSync(tokenFile, 'utf8').trim()
  if (!hookToken) throw new Error('pane wrote an empty hook token')

  const proj = projectDir(workDir)
  mkdirSync(proj, { recursive: true })
  let ts = Date.UTC(2026, 0, 1)

  return {
    name,
    workDir,
    write(conv, texts) {
      const body = texts.map((t, i) => line(conv, `${conv}-${i}-${ts++}`, t, ts)).join('\n')
      writeFileSync(join(proj, `${conv}.jsonl`), texts.length ? `${body}\n` : '')
    },
    append(conv, texts) {
      const body = texts.map((t, i) => line(conv, `${conv}-a${i}-${ts++}`, t, ts)).join('\n')
      appendFileSync(join(proj, `${conv}.jsonl`), `${body}\n`)
    },
    async hook(conv) {
      const res = await fetch(`${backend.backendUrl}/api/_internal/hook`, {
        method: 'POST',
        headers: { 'X-Supermux-Hook-Token': hookToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: name,
          event: 'SessionStart',
          payload: conv ? { session_id: conv } : {},
        }),
      })
      expect(res.status, 'the hook endpoint must accept the pane token').toBe(200)
    },
  }
}

/** Seed the page: auth token + the chat renderer flag, before first navigation. */
export async function primePage(page: Page, backend: Backend): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 }) // the desktop focus seam
  await page.addInitScript(
    ({ token, flag }: { token: string; flag: string }) => {
      ;(window as unknown as Record<string, unknown>)._SUPERMUX_AUTH_TOKEN = token
      ;(window as unknown as Record<string, unknown>)._SUPERMUX_VERSION = 'e2e'
      window.localStorage.setItem('supermux-ui', flag)
    },
    { token: backend.token, flag: CHAT_FLAG_ON },
  )
}

/**
 * Count how many chat sockets this page has opened and how many have closed.
 *
 * Installed as an init script, so it wraps `WebSocket` before the app's first
 * dial. It is the only way to tell the two failure shapes apart from the
 * outside: "the surface says stale while the socket is still up" (T3.2) versus
 * "the surface says stale because the socket died" — and to prove a terminal
 * close really stopped the redial loop rather than merely slowing it (T3.5).
 */
export async function countSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __chatWs?: { opened: number; closed: number } }
    w.__chatWs = { opened: 0, closed: 0 }
    const Native = window.WebSocket
    const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
      const sock = new Native(url as string, protocols as string[])
      if (String(url).includes('/chat')) {
        w.__chatWs!.opened++
        sock.addEventListener('close', () => {
          w.__chatWs!.closed++
        })
      }
      return sock
    } as unknown as typeof WebSocket
    Wrapped.prototype = Native.prototype
    Object.assign(Wrapped, {
      CONNECTING: Native.CONNECTING,
      OPEN: Native.OPEN,
      CLOSING: Native.CLOSING,
      CLOSED: Native.CLOSED,
    })
    window.WebSocket = Wrapped
  })
}

export async function socketCounts(page: Page): Promise<{ opened: number; closed: number }> {
  return page.evaluate(
    () => (window as unknown as { __chatWs: { opened: number; closed: number } }).__chatWs,
  )
}

/**
 * The honesty chip's state, or `'live'` when it is (correctly) not rendered —
 * `ConnectionNote` renders nothing while healthy, on purpose.
 *
 * `'gone'` when the panel itself is not mounted. Without that distinction an
 * unmounted surface reads as a healthy one, which is the single easiest way to
 * write a reconnect spec that passes for the wrong reason.
 */
export async function connectionState(page: Page): Promise<string> {
  if ((await page.getByTestId('chat-panel').count()) === 0) return 'gone'
  const chip = page.locator('[data-vr="chat-connection"]')
  if ((await chip.count()) === 0) return 'live'
  return (await chip.first().getAttribute('data-state')) ?? 'unlabelled'
}

/** How many times `token` appears in the rendered transcript. The dedupe this
 *  asserts is arithmetic on `seq` in the client, so a duplicate is a real
 *  regression and never a rendering artefact. */
export async function tokenCount(page: Page, token: string): Promise<number> {
  // `textContent`, not `innerText`: a 500-entry transcript is a big enough DOM
  // that forcing layout on every poll dominates the test's runtime, and the
  // tokens are plain text either way.
  return page.evaluate(
    (t: string) =>
      (document.querySelector('[data-testid="chat-panel"]')?.textContent ?? '').split(t).length - 1,
    token,
  )
}

/** Wait until the transcript holds `token` exactly once. */
export async function expectTokenOnce(page: Page, token: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => tokenCount(page, token), { timeout, message: `transcript should hold ${token} exactly once` })
    .toBe(1)
}

/**
 * Load one page of backlog through the surface's own control.
 *
 * The click is DISPATCHED IN-PAGE rather than driven with `locator.click()`,
 * and that is not a shortcut — it is the only reliable form here. The surface
 * re-pins itself to the bottom on every render while the reader is at the
 * bottom (`chat-panel.tsx:278-281`), so Playwright's scroll-into-view is undone
 * between the hit test and the mouse-down and the click silently lands on a
 * message instead. (Scrolling the container to its top edge does work — it is
 * how a reader reaches this — but on a 500-entry transcript it costs tens of
 * seconds of layout in a dev build, which is a rig cost, not a product signal.)
 * The handler under test is the same one either way.
 */
export async function loadOlderPage(page: Page): Promise<void> {
  await page.getByTestId('chat-load-older').first().evaluate((el: HTMLElement) => el.click())
}

/** Drive the page's visibility the way a phone does. The app listens on
 *  `document.visibilityState` + the `visibilitychange` event
 *  (`use-chat-ws.ts:120`), and Playwright has no API for either, so the state
 *  is overridden and the event dispatched — the same pair the browser fires. */
export async function setVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((s: string) => {
    Object.defineProperty(document, 'visibilityState', { value: s, configurable: true })
    Object.defineProperty(document, 'hidden', { value: s === 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
