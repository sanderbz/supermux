/**
 * Smoke e2e — THE BROKERED SIGN-IN COMES BACK CONNECTED.
 * ─────────────────────────────────────────────────────────────────────────────
 * The bug, in the owner's words: Store → InhouseSEO → pick a bot → "Sign in with
 * InhouseSEO" → consent → back in supermux, and the sheet shows its INITIAL state
 * again — "Choose who gets it first", the bot list with nothing selected, and a
 * SECOND "Grant to · This bot / All agents" segment underneath. Nothing said he
 * was connected. So he signed in again. The server had completed both times
 * (`connector.oauth.connected`, health ok, 32 tools).
 *
 * Nothing about that is reproducible without a real browser: the flow LEAVES the
 * page (a top-level redirect to the provider and back), which is precisely what
 * the old local-state derivation could not survive. So this drives the whole
 * journey in chromium against a real booted binary, with a mock authorization
 * server + remote MCP behind a cloudflared quick tunnel (see
 * `connector-oauth-mock.ts` for why a tunnel is required).
 *
 * Covered here, in the DOM and against the API:
 *   (i)   Store → pick a bot → sign in → consent → back CONNECTED, naming the
 *         identity and the tool count, with a "Restart <bot> to apply" line —
 *         and no initial state, no second picker, no terminal copy.
 *   (ii)  a reload still says connected (server truth, not a returning tab).
 *   (iii) signing in again for the same bot mints NO duplicate account or grant.
 *
 * SKIPS (never fails) when there is no outbound tunnel: cloudflared missing, or
 * the quick tunnel not coming up. That is an environment fact, not a regression.
 * The chat-card half of the flow — the same lane with the bot as the fixed
 * target, no picker — is covered by `tests/unit/oauth-return-ux.test.tsx` and
 * `tests/unit/connect-card-oauth.test.tsx`, because raising an in-chat Connect
 * card needs a live Claude agent, which this suite deliberately cannot run
 * (see `missingAgentCredentials` in harness.ts).
 */
import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { api, freePort, injectGlobals, startBackend, type Backend } from './harness'
import {
  MOCK_EMAIL,
  MOCK_TOOLS,
  openQuickTunnel,
  startMockAs,
  tunnelReady,
  type MockState,
} from './connector-oauth-mock'

const CONNECTOR_ID = 'mock-seo'
const CONNECTOR_NAME = 'Mock SEO'
const BOT = 'folderwijzer'
/** Where the screenshots for the PR land. */
const SHOTS = join(process.env.HOME ?? '/tmp', 'oauthux-shots')

// The tunnel + the sign-in round trip are network-bound; the suite default (60 s)
// is a measurement of a LOCAL test's worst case and does not fit this one.
test.describe.configure({ mode: 'serial' })

test.describe('brokered OAuth sign-in returns connected', () => {
  let backend: Backend
  let mock: Server | null = null
  let mockState: MockState | null = null
  let tunnel: ChildProcess | null = null
  let base = ''

  test.beforeAll(async () => {
    // A cloudflared quick tunnel takes ~25 s to be announced AND propagated to
    // the edge; the suite's 60 s default is a measurement of a LOCAL test's
    // worst case, not of a public DNS name coming up.
    test.setTimeout(180_000)
    const port = await freePort()
    const started = startMockAs(port)
    mock = started.server
    mockState = started.state
    const opened = await openQuickTunnel(port)
    if (opened) {
      tunnel = opened.proc
      if (await tunnelReady(opened.url)) {
        base = opened.url
        started.state.base = opened.url
      }
    }
    try {
      mkdirSync(SHOTS, { recursive: true })
    } catch {
      /* best-effort */
    }
  })

  test.afterAll(async () => {
    tunnel?.kill('SIGTERM')
    mock?.close()
  })

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('sign in → back connected, one picker, restart hint, no duplicates', async ({ page }) => {
    test.skip(base === '', 'no cloudflared quick tunnel — the mock AS cannot be reached publicly')
    // The tunnel hop + a real OAuth round trip + a probe. Measured at ~25 s on
    // this box; 180 s is the bound on how long being wrong is allowed to cost.
    test.setTimeout(180_000)

    await page.addInitScript(injectGlobals(backend.token))

    // ── seed: a running bot to grant to, and the connector pointed at the mock ──
    expect((await api(backend).createSession({ name: BOT, provider: 'shell', dir: backend.dataDir })).ok).toBe(true)
    expect((await api(backend).startSession(BOT)).ok).toBe(true)

    const install = await fetch(`${backend.backendUrl}/api/connectors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: CONNECTOR_ID,
        kind: 'mcp_catalog',
        display_name: CONNECTOR_NAME,
        icon: '',
        description: 'A mock remote MCP that brokers its sign-in.',
        tools: [],
        credentials: [],
        auth: { kind: 'mcp_oauth' },
        emit: { url: `${base}/mcp` },
      }),
    })
    expect(install.ok).toBe(true)

    // ── (i) the journey ────────────────────────────────────────────────────────
    // The whole trip stays on the LOOPBACK origin (a trusted owner transport, so
    // the callback the broker registers is one the browser can reach) — which is
    // also what keeps the pending `state` in one origin's sessionStorage.
    await page.goto(`${backend.backendUrl}/store/${CONNECTOR_ID}`)

    const lane = page.getByTestId('oauth-lane')
    await expect(lane).toBeVisible()
    await expect(lane).toHaveAttribute('data-state', 'not_connected')
    // The old sheet's copy told the owner to approve the sign-in in the bot's own
    // terminal — a flow that does not exist. It came from the frozen install-time
    // auth snapshot; the card now reads the live catalog.
    await expect(lane).not.toContainText('terminal')
    await expect(lane).toContainText("you'll come straight back here")
    await page.screenshot({ path: join(SHOTS, '01-not-connected.png'), fullPage: true })

    // ONE picker: the library "Grant to" step. There must not be a second one.
    await expect(page.getByText('Grant to', { exact: true })).toHaveCount(1)
    await expect(page.getByText("Prefer to finish in a bot's chat?")).toHaveCount(0)

    await page.getByRole('checkbox', { name: BOT }).click()
    const signIn = page.getByRole('button', { name: `Sign in with ${CONNECTOR_NAME}` })
    await expect(signIn).toBeEnabled()
    await signIn.click()

    // The provider auto-approves and bounces the browser back through the public
    // callback → `?oauth_pending=1` → the authenticated `complete`.
    await page.waitForURL(new RegExp(`/store/${CONNECTOR_ID}`), { timeout: 90_000 })
    await expect(lane).toHaveAttribute('data-state', 'connected', { timeout: 60_000 })
    await expect(page.getByTestId('oauth-status')).toContainText(
      `Connected as ${MOCK_EMAIL} — ${MOCK_TOOLS.length} tools`,
    )
    // The bot is running on a launch that predates the grant, so the honest next
    // step is offered — as a one-tap action, not a sentence.
    await expect(page.getByRole('button', { name: `Restart ${BOT} to apply` })).toBeVisible()
    // …and the initial state is GONE: no picker to re-choose, no second grant
    // segment, no competing "Sign in" primary.
    await expect(page.getByText('Grant to', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Choose who gets it first')).toHaveCount(0)
    await expect(page.getByRole('button', { name: `Sign in with ${CONNECTOR_NAME}` })).toHaveCount(0)
    await page.screenshot({ path: join(SHOTS, '02-connected.png'), fullPage: true })

    // The server agrees — the card carries the account, and the grant is honest
    // about not being applied to the running bot yet.
    const card = await (
      await fetch(`${backend.backendUrl}/api/connectors/${CONNECTOR_ID}`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
    ).json()
    expect(card.accounts).toHaveLength(1)
    expect(card.accounts[0].account_label).toBe(MOCK_EMAIL)
    expect(card.accounts[0].health).toBe('ok')
    expect(card.accounts[0].tool_count).toBe(MOCK_TOOLS.length)
    // The lane + copy come from the LIVE descriptor, never the install snapshot.
    expect(card.auth.kind).toBe('mcp_oauth')

    const grants = await (
      await fetch(`${backend.backendUrl}/api/sessions/${BOT}/connectors`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
    ).json()
    const grant = grants.connectors.find((g: { connector_id: string }) => g.connector_id === CONNECTOR_ID)
    expect(grant).toBeTruthy()
    expect(grant.applied).toBe(false)
    expect(mockState?.toolsList).toBeGreaterThan(0)

    // ── (ii) a reload still says connected — it is server truth, not a tab ──
    await page.reload()
    await expect(page.getByTestId('oauth-lane')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 })
    await expect(page.getByTestId('oauth-status')).toContainText(`Connected as ${MOCK_EMAIL}`)
    await page.screenshot({ path: join(SHOTS, '03-after-reload.png'), fullPage: true })

    // ── (iii) signing in AGAIN for the same bot must not fork the account ──
    // The connected state offers "Sign in again" only when the account is dead,
    // so drive the second round trip the way a re-auth does: straight at the
    // broker's own start endpoint from this page, then follow it in the browser.
    await page.evaluate(async (id) => {
      const r = await fetch(`/api/connectors/${id}/oauth/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${window._SUPERMUX_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_name: 'folderwijzer', return_to: `/store/${id}` }),
      })
      const body = (await r.json()) as { authorize_url: string; state: string }
      sessionStorage.setItem(
        'supermux.oauth.pending',
        JSON.stringify({ id, target: 'folderwijzer', returnTo: `/store/${id}`, state: body.state }),
      )
      location.assign(body.authorize_url)
    }, CONNECTOR_ID)

    await page.waitForURL(new RegExp(`/store/${CONNECTOR_ID}`), { timeout: 90_000 })
    await expect(page.getByTestId('oauth-lane')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 })

    const card2 = await (
      await fetch(`${backend.backendUrl}/api/connectors/${CONNECTOR_ID}`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
    ).json()
    expect(card2.accounts).toHaveLength(1)
    const consumers = await (
      await fetch(`${backend.backendUrl}/api/connectors/${CONNECTOR_ID}/grants`, {
        headers: { Authorization: `Bearer ${backend.token}` },
      })
    ).json()
    expect(consumers.grants).toHaveLength(1)
    await page.screenshot({ path: join(SHOTS, '04-second-signin-no-duplicate.png'), fullPage: true })
  })
})
