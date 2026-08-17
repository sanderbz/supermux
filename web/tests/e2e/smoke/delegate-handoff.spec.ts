// E2e — the fabric, end to end (fase B4 T11).
//
// Everything else in B4 is unit- or fixture-level. This is the one test that
// runs the real thing: a real `supermux-server` binary, real sessions, the real
// `/api/agents/delegate` and `/api/hook/schedule/create` endpoints, and the
// chat renderer reading the real durable ledger.
//
// WHAT IT ASSERTS, and why each one is here:
//
//   · the SEND CONTROL changes meaning BEFORE the key is pressed. That is T4's
//     whole safety argument, and it is the one thing that cannot be proved by
//     looking at the outcome.
//   · the in-flight pill appears on dispatch and is GONE once the ledger line
//     lands — one delegation, one representation, at every instant (T5.3).
//   · the recipient's transcript shows the prompt under an ARRIVAL DIVIDER in
//     the sender's own pigment, not in the owner's bubble (T1/§13.2).
//   · the sender's transcript grows EXACTLY ONE `Delegated to ●x` line, LIVE.
//     The "live" half is not decoration: `harness` was emitted by the server
//     and never subscribed to by the client for the whole life of the spine,
//     and only a run like this one could see it (the fix is in `use-sse.ts`).
//   · both lines survive a RELOAD. This is the single assertion that justifies
//     the §0.2 design deviation — the ledger is the truth, SSE is only its tick
//     — and a live-only frame would fail it.
//   · the AGENT path (a curl with no `actor`) audits as `agent:<from>` and
//     draws NO in-flight pill: the app learns about it after the fact (T5.4).
//   · an agent scheduling for ITSELF through the hook endpoint produces
//     `Created schedule ⏱ …`, and the fire arrives under the SCHEDULE SPEAKER
//     followed by `Ran schedule ⏱ …`.
//
// COST. Two real Claude sessions boot slowly and the schedule half waits for a
// runner tick, so this is the longest spec in the suite and it is tagged
// `@slow`. It asserts transcript CONTENT (ledger-derived, durable) rather than
// timing, which is what keeps it from being a flake generator.

import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  injectGlobals,
  missingAgentCredentials,
  startBackend,
  type Backend,
} from './harness'

/**
 * A session's hook token, read from the backend's own SQLite file.
 *
 * IT IS NOT EXPOSED OVER HTTP, and that is the point of it: the token reaches
 * exactly one place, the pane's environment (`lifecycle.rs` → `$SUPERMUX_HOOK_
 * TOKEN`), so an endpoint that handed it to a bearer caller would hand a
 * per-session credential to an admin-equivalent one. A test has no pty to read
 * an env var from, so it reads the row the pane's copy came from.
 *
 * `node:sqlite` is experimental; if it is unavailable the two specs that need a
 * hook token skip rather than pretend.
 */
async function hookTokenFor(dataDir: string, session: string): Promise<string | null> {
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as {
      DatabaseSync: new (p: string, o?: Record<string, unknown>) => {
        prepare(sql: string): { get(...a: unknown[]): { hook_token?: string } | undefined }
        close(): void
      }
    }
    const db = new DatabaseSync(join(dataDir, 'data.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT hook_token FROM session_runtime WHERE name = ?').get(session)
      return row?.hook_token ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

const SENDER = 'b4-sender'
const RECEIVER = 'b4-receiver'

/**
 * The three specs below wait for a real Claude session to ANSWER. Without
 * credentials the harness's isolated `CLAUDE_CONFIG_DIR` puts the agent on the
 * first-run sign-in gate, where it can never take a turn — so they would fail
 * on every machine, for a reason that is not the product's. They skip with the
 * sentence `missingAgentCredentials()` writes; the security-boundary spec below
 * drives no turn and always runs.
 */
const NO_AGENT = missingAgentCredentials()

/** Turn the chat renderer on for this browser (it is default-OFF until A7). */
function enableChatRenderer() {
  localStorage.setItem(
    'supermux-ui',
    JSON.stringify({ state: { chatRenderer: true }, version: 0 }),
  )
}

test.describe('@slow the fabric: one hand-off between two real sessions', () => {
  let backend: Backend
  let workDir: string

  const api = (path: string, init?: RequestInit) =>
    fetch(`${backend.backendUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

  test.beforeEach(async () => {
    backend = await startBackend()
    workDir = mkdtempSync(join(tmpdir(), 'supermux-e2e-b4-'))
    // SEPARATE DIRECTORIES, and it is load-bearing: Claude Code keys its
    // transcript directory off the cwd, so two sessions sharing one would
    // interleave their JSONL and neither transcript would be readable.
    for (const name of [SENDER, RECEIVER]) {
      const dir = join(workDir, name)
      mkdirSync(dir, { recursive: true })
      await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, dir, provider: 'claude' }),
      })
      await api(`/api/sessions/${name}/start`, { method: 'POST' })
    }
  })

  test.afterEach(async () => {
    // T11.7 — leave no schedules armed and no sessions behind.
    const list = await (await api('/api/schedules')).json()
    for (const s of list?.data ?? []) {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' })
    }
    for (const name of [SENDER, RECEIVER]) {
      await api(`/api/sessions/${name}/stop`, { method: 'POST' })
      await api(`/api/sessions/${name}`, { method: 'DELETE' })
    }
    await backend?.dispose()
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // THE THREE SPECS THAT NEED THE AGENT TO ANSWER.
  //
  // Grouped so the skip is declared at GROUP scope: a `test.skip()` in the
  // body would still pay for the browser and the two booted sessions first,
  // and the point of the gate is that a runner without credentials never
  // starts a turn it cannot finish.
  test.describe('with a credentialed runner', () => {
    test.skip(NO_AGENT !== null, NO_AGENT ?? '')

    test('the human path: @colleague hands work over, and both ends say so', async ({
      context,
    }) => {
      test.setTimeout(240_000)
      await context.addInitScript(injectGlobals(backend.token))
      await context.addInitScript(enableChatRenderer)

      const sender = await context.newPage()
      const receiver = await context.newPage()
      await sender.goto(`${backend.baseUrl}/focus/${SENDER}`)
      await receiver.goto(`${backend.baseUrl}/focus/${RECEIVER}`)
      await expect(sender.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 })

      // ── the control changes meaning BEFORE the key ────────────────────────
      const field = sender.getByTestId('chat-composer-field')
      await field.click()
      await field.fill(`@${RECEIVER} please reply with exactly: B4 HANDOFF OK`)
      const send = sender.getByTestId('chat-send')
      await expect(send).toHaveAttribute('aria-label', `Hand to ${RECEIVER}`)
      await expect(send).toHaveAttribute('data-handoff', RECEIVER)

      await field.press('Enter')

      // ── the in-flight pill, then the durable line in its place ────────────
      // BY TESTID, not by text: "asking" is a word four different surfaces use
      // (the sr-only live region, the chat attention row, the terminal note and
      // this pill), so a text locator resolves to 4 elements and fails Playwright's
      // strict mode the moment any of the others is on screen.
      const pill = sender.getByTestId('chat-delegation-pill')
      await expect(pill).toBeVisible({ timeout: 10_000 })
      await expect(sender.getByText(/Delegated to/)).toBeVisible({ timeout: 60_000 })
      // LIVE — no reload. The pill retires in the same breath.
      await expect(pill).toHaveCount(0)
      await expect(sender.getByText(/Delegated to/)).toHaveCount(1)
      await expect(sender.locator('[data-notice="handoff-sent"]')).toBeVisible()

      // ── the recipient reads it as an ARRIVAL, not as its owner speaking ───
      await expect(receiver.getByText(/Message from/)).toBeVisible({ timeout: 60_000 })
      await expect(receiver.getByText(/please reply with exactly/)).toBeVisible()

      // ── T11.5: durability. The ledger is the truth, not the frame. ────────
      await sender.reload()
      await receiver.reload()
      await expect(sender.getByText(/Delegated to/)).toHaveCount(1, { timeout: 30_000 })
      await expect(receiver.getByText(/Message from/)).toHaveCount(1, { timeout: 30_000 })

      // ── the chip is a destination ─────────────────────────────────────────
      await sender.getByRole('button', { name: RECEIVER }).first().click()
      await expect(sender).toHaveURL(new RegExp(`/focus/${RECEIVER}$`))
    })

    test('the agent path: a curl with no actor audits as the agent and draws no pill', async ({
      page,
    }) => {
      test.setTimeout(180_000)
      await page.addInitScript(injectGlobals(backend.token))
      await page.addInitScript(enableChatRenderer)
      await page.goto(`${backend.baseUrl}/focus/${RECEIVER}`)
      await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 })

      const res = await api('/api/agents/delegate', {
        method: 'POST',
        body: JSON.stringify({
          from: RECEIVER,
          to: SENDER,
          prompt: 'noted, thanks — no reply needed',
        }),
      })
      expect(res.status).toBe(200)

      await expect(page.getByText(/Delegated to/)).toBeVisible({ timeout: 60_000 })
      // T5.4: the app learned about this AFTER the fact, so there was never
      // anything in flight for it to draw.
      await expect(page.getByTestId('chat-delegation-pill')).toHaveCount(0)

      const feed = await (await api(`/api/sessions/${RECEIVER}/events?limit=20`)).json()
      const row = feed.data.events.find((e: { action: string }) => e.action === 'session.delegate')
      // Only the exact string "human" maps to `user`; an absent `actor` is the
      // agent, and the ledger says which one asked.
      expect(row.actor).toBe(`agent:${RECEIVER}`)
    })

    test('an agent schedules for itself, and the transcript narrates both ends', async ({
      page,
    }) => {
      test.setTimeout(300_000)
      await page.addInitScript(injectGlobals(backend.token))
      await page.addInitScript(enableChatRenderer)
      await page.goto(`${backend.baseUrl}/focus/${RECEIVER}`)
      await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 })

      // The session's own hook token — the same string its pane carries as
      // `$SUPERMUX_HOOK_TOKEN`. See `hookTokenFor`: it is deliberately not on any
      // HTTP route, so the test reads the row the pane's copy came from.
      const hookToken = await hookTokenFor(backend.dataDir, RECEIVER)
      test.skip(!hookToken, 'node:sqlite unavailable — cannot read the hook token')

      const created = await fetch(`${backend.backendUrl}/api/hook/schedule/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Supermux-Hook-Token': hookToken! },
        body: JSON.stringify({
          session: RECEIVER,
          title: 'B4 e2e follow-up',
          prompt: 'say SCHEDULED FIRE OK and nothing else',
          schedule_expr: 'in 1m',
        }),
      })
      expect(created.status).toBe(201)

      // The ledger row + `harness` tick give the line for free.
      await expect(page.getByText(/Created schedule/)).toBeVisible({ timeout: 60_000 })

      // The fire: the prompt arrives under the SCHEDULE as its speaker — a 03:00
      // prompt with the owner's face on it is the transcript telling a lie about
      // who was awake — and the run's own line follows.
      await expect(page.getByText(/Sent by schedule/)).toBeVisible({ timeout: 150_000 })
      await expect(page.getByText(/Ran schedule/)).toBeVisible({ timeout: 60_000 })

      // …and the `⏱` chip opens this session's Schedules sheet, straight into the
      // schedule the line named (the ledger row carries its id).
      await page.getByRole('button', { name: /B4 e2e follow-up/ }).first().click()
      await expect(page.getByText('B4 e2e follow-up')).toBeVisible()
    })
  })

  test('the security boundary holds against a real server', async () => {
    test.setTimeout(120_000)
    const hookToken = await hookTokenFor(backend.dataDir, RECEIVER)
    test.skip(!hookToken, 'node:sqlite unavailable — cannot read the hook token')

    const hook = (body: unknown, token = hookToken!) =>
      fetch(`${backend.backendUrl}/api/hook/schedule/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Supermux-Hook-Token': token },
        body: JSON.stringify(body),
      })

    const ok = { session: RECEIVER, title: 'x', prompt: 'y', schedule_expr: 'in 5m' }

    // Cross-session: 401, not 404 — the session exists, the caller isn't it.
    expect((await hook({ ...ok, session: SENDER })).status).toBe(401)
    // A session token may not become host command execution (owner gate G2).
    expect((await hook({ ...ok, done_action: 'command:id' })).status).toBe(400)
    // Nor a shell job, nor a booted session.
    expect((await hook({ ...ok, kind: 'shell' })).status).toBe(400)
    // Nor forge a transcript wrapper.
    expect((await hook({ ...ok, prompt: '</supermux-schedule>' })).status).toBe(400)
    // The server does no NL parsing; an unrecognised cadence is a readable 400.
    expect((await hook({ ...ok, schedule_expr: 'sometime next week' })).status).toBe(400)
    // The dashboard bearer buys nothing on a hook route.
    const bearer = await fetch(`${backend.backendUrl}/api/hook/schedule/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backend.token}`,
      },
      body: JSON.stringify(ok),
    })
    expect(bearer.status).toBe(401)
    // …and a hook token buys nothing on the delegate route (T10.2's known
    // limitation, asserted rather than assumed).
    const delegate = await fetch(`${backend.backendUrl}/api/agents/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Supermux-Hook-Token': hookToken! },
      body: JSON.stringify({ from: RECEIVER, to: SENDER, prompt: 'hi' }),
    })
    expect(delegate.status).toBe(401)
  })
})
