// R5 mobile action-panels e2e — panels-unify + curated quick-keys + title-dots
// removal. Served from the built `dist` (vite preview); ALL backend traffic is
// stubbed at the network layer so the test is hermetic + fast while still
// exercising the REAL app code.
//
// Asserts:
//   1. all THREE dock triggers (slash / dots / +) open a quirk-free Vaul sheet
//      with a backdrop, and a backdrop tap dismisses it (the shared shell);
//   2. the quick-keys sheet shows the default chips with ZERO setup;
//   3. tapping a chip sends the RIGHT bytes via the existing WS input path
//      (Esc → "\x1b" through sendKey; "Continue" → "continue\r" through send);
//   4. Edit mode toggles an entry and PERSISTS it (PUT /api/prefs/quick_keys);
//   5. the redundant title-bar dots are gone (the bottom session pill stays).

import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

const TOKEN = 'mobile-e2e-token'
const SESSION = 'demo'

/** The captured `{type:'input'}` payloads the page sent over the (mocked) WS. */
type WsCapture = { inputs: string[] }

/** Install all REST + SSE + WS mocks, plus the runtime globals. Returns the
 *  shared capture buffers the assertions read. An optional `initialQuickKeys`
 *  seeds the GET /api/prefs/quick_keys response so a test can render chips that
 *  are not in the default selection (e.g. the Ctrl-L / Esc-Esc / Newline
 *  control combos) without driving Edit mode first. */
async function installMocks(
  page: Page,
  opts: { initialQuickKeys?: string[] } = {},
): Promise<{
  ws: WsCapture
  prefsPuts: () => string[]
}> {
  await page.addInitScript((token) => {
    window._SUPERMUX_AUTH_TOKEN = token
    window._SUPERMUX_VERSION = 'e2e'
    // Suppress the iOS-Safari "Add to home screen" install sheet (WebKit only) —
    // it auto-opens on a fresh load and overlaps the dock, intercepting taps.
    try {
      localStorage.setItem('supermux-a2hs-dismissed', String(Date.now()))
    } catch {
      /* ignore */
    }
  }, TOKEN)

  const prefsPuts: string[] = []

  // ── REST ────────────────────────────────────────────────────────────────────
  // ONE handler for every /api/** request, branching on pathname + method. A
  // single route removes all the route-precedence/method ambiguity Playwright's
  // newest-first matching introduces when overlapping globs (catch-all vs
  // specific) compete across GET vs PUT for the same URL.
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/**', (r) => {
    const req = r.request()
    const path = new URL(req.url()).pathname
    const method = req.method()

    if (path === '/api/health') return r.fulfill(json({ ok: true }))

    if (path === '/api/sessions') {
      return r.fulfill(
        json({
          ok: true,
          data: [
            {
              name: SESSION,
              status: 'idle',
              dir: '/tmp',
              provider: 'shell',
              preview_lines: [],
              updated_at: '',
            },
          ],
        }),
      )
    }

    if (path === '/api/slash-commands') {
      return r.fulfill(
        json({
          ok: true,
          data: [
            { cmd: '/compact', desc: 'Compact the conversation' },
            { cmd: '/clear', desc: 'Clear the screen' },
            { cmd: '/status', desc: 'Show status' },
          ],
        }),
      )
    }

    if (path === '/api/snippets') return r.fulfill(json({ ok: true, data: [] }))

    if (path === '/api/prefs/quick_keys') {
      if (method === 'PUT') {
        // Body is `{ value: "<json-string>" }`; capture the inner value so the
        // test can assert the persisted selection changed.
        let value: string
        try {
          value = (JSON.parse(req.postData() ?? '{}') as { value?: string }).value ?? ''
        } catch {
          value = req.postData() ?? ''
        }
        prefsPuts.push(value)
        return r.fulfill(json({ ok: true, data: { key: 'quick_keys', value } }))
      }
      // GET → either a seeded selection (so a test can render non-default
      // chips) or null (unset) → the default selection renders.
      const value = opts.initialQuickKeys
        ? JSON.stringify({ selected: opts.initialQuickKeys })
        : null
      return r.fulfill(json({ ok: true, data: { key: 'quick_keys', value } }))
    }

    if (path === '/api/events') {
      // SSE channel — open + empty (no events) for the test lifetime.
      return r.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    }

    // Any other /api call — a benign empty envelope so nothing 404s into error.
    return r.fulfill(json({ ok: true, data: null }))
  })

  // ── WebSocket (the live terminal) ─────────────────────────────────────────────
  const ws: WsCapture = { inputs: [] }
  await page.routeWebSocket(/\/ws\/sessions\//, (route: WebSocketRoute) => {
    // We mock the server side entirely (no upstream connect). The client sends
    // {type:'auth',token} first; we reply {type:'auth_ok'} so it goes `live`.
    route.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString()
      let msg: { type?: string; data?: string }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.type === 'auth') {
        route.send(JSON.stringify({ type: 'auth_ok' }))
      } else if (msg.type === 'input' && typeof msg.data === 'string') {
        ws.inputs.push(msg.data)
      }
      // resize / other frames are ignored.
    })
  })

  return { ws, prefsPuts: () => prefsPuts }
}

/** Open the mobile focus route + wait for the dock to be interactive. */
async function gotoFocus(page: Page) {
  await page.goto(`/focus/${SESSION}`)
  // The dock's Specials trigger is the canonical "we're on the mobile dock" probe.
  await expect(page.getByRole('button', { name: 'Specials' })).toBeVisible()
}

test.describe('mobile action panels (R5 unify + quick-keys)', () => {
  test('slash / dots / + all open the shared Vaul sheet with backdrop dismiss', async ({
    page,
  }) => {
    await installMocks(page)
    await gotoFocus(page)

    // Vaul renders its overlay with data-vaul-overlay; assert each trigger opens
    // a sheet (its title + overlay) and a backdrop tap dismisses it.
    const overlay = page.locator('[data-vaul-overlay]')

    // 1) Slash → "Commands" sheet.
    await page.getByRole('button', { name: 'Slash command' }).click()
    await expect(page.getByText('Commands', { exact: true })).toBeVisible()
    await expect(overlay).toBeVisible()
    await overlay.click({ position: { x: 10, y: 10 } })
    await expect(page.getByText('Commands', { exact: true })).toBeHidden()

    // 2) Dots (Specials) → "Quick keys" sheet.
    await page.getByRole('button', { name: 'Specials' }).click()
    await expect(page.getByText('Quick keys', { exact: true })).toBeVisible()
    await expect(overlay).toBeVisible()
    await overlay.click({ position: { x: 10, y: 10 } })
    await expect(page.getByText('Quick keys', { exact: true })).toBeHidden()

    // 3) Plus → "Snippets" sheet.
    await page.getByRole('button', { name: 'Snippets' }).click()
    await expect(page.getByText('Snippets', { exact: true })).toBeVisible()
    await expect(overlay).toBeVisible()
    await overlay.click({ position: { x: 10, y: 10 } })
    await expect(page.getByText('Snippets', { exact: true })).toBeHidden()
  })

  test('quick-keys default chips render and tap-to-send the right WS bytes', async ({
    page,
  }) => {
    const { ws } = await installMocks(page)
    await gotoFocus(page)

    // Wait for the WS to authenticate so `send`/`sendKey` are not silenced.
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Specials' }).click()
    await expect(page.getByText('Quick keys', { exact: true })).toBeVisible()

    // Default selection chips (zero setup): "Interrupt" (Esc) + "Continue".
    const interrupt = page.getByRole('button', { name: 'Interrupt' })
    const cont = page.getByRole('button', { name: 'Continue' })
    await expect(interrupt).toBeVisible()
    await expect(cont).toBeVisible()

    // Tap Interrupt → sendKey('Esc') → "\x1b" over the WS. One tap closes too.
    await interrupt.click()
    await expect(page.getByText('Quick keys', { exact: true })).toBeHidden()
    await expect.poll(() => ws.inputs).toContain('\x1b')

    // Re-open + tap Continue → send('continue\r').
    await page.getByRole('button', { name: 'Specials' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.poll(() => ws.inputs).toContain('continue\r')
  })

  test('mode-cycle = Shift+Tab and the new control combos send the right bytes', async ({
    page,
  }) => {
    // Seed a selection containing the corrected mode-cycle chip plus the three
    // genuinely touch-impossible / browser-intercepted combos so they all
    // render in tap-to-send mode (none are in the default selection except the
    // mode-cycle chip).
    const { ws } = await installMocks(page, {
      initialQuickKeys: ['key:BackTab', 'key:EscEsc', 'key:Ctrl-L', 'key:Newline'],
    })
    await gotoFocus(page)

    // Wait for the WS to authenticate so `sendKey` is not silenced.
    await expect(page.locator('[data-state="live"]')).toBeVisible({ timeout: 15_000 })

    const open = async () => {
      await page.getByRole('button', { name: 'Specials' }).click()
      await expect(page.getByText('Quick keys', { exact: true })).toBeVisible()
    }

    // Mode-cycle chip → sendKey('BackTab') → CSI Z (Shift+Tab), NOT plain Tab.
    await open()
    await page.getByRole('button', { name: /Cycle mode/ }).click()
    await expect.poll(() => ws.inputs).toContain('\x1b[Z')
    // It must NOT have sent a plain Tab — that was the bug.
    expect(ws.inputs).not.toContain('\t')

    // Rewind chip → sendKey('EscEsc') → two Escapes in one send.
    await open()
    await page.getByRole('button', { name: /Rewind/ }).click()
    await expect.poll(() => ws.inputs).toContain('\x1b\x1b')

    // Clear screen → sendKey('Ctrl-L') → FF (\x0c).
    await open()
    await page.getByRole('button', { name: 'Clear screen' }).click()
    await expect.poll(() => ws.inputs).toContain('\x0c')

    // Newline (Shift+Enter) → sendKey('Newline') → LF (\x0a), inserts a line
    // break in Claude Code's prompt WITHOUT submitting (Enter = \r submits).
    // Device-verified against Claude Code v2.1.150 (tmux send-keys C-j).
    await open()
    await page.getByRole('button', { name: /Newline/ }).click()
    await expect.poll(() => ws.inputs).toContain('\x0a')
  })

  test('Edit mode toggles an entry and persists it to /api/prefs/quick_keys', async ({
    page,
  }) => {
    const { prefsPuts } = await installMocks(page)
    await gotoFocus(page)

    await page.getByRole('button', { name: 'Specials' }).click()
    await expect(page.getByText('Quick keys', { exact: true })).toBeVisible()

    // Enter Edit mode → the full catalog of toggles appears (incl. a slash entry
    // that is NOT in the default selection, so toggling it is a real change).
    await page.getByRole('button', { name: 'Edit quick keys' }).click()
    const slashToggle = page.getByRole('button', { name: '/compact' })
    // The Commands section is below Control + Replies — scroll it into view.
    await slashToggle.scrollIntoViewIfNeeded()
    await expect(slashToggle).toBeVisible()
    expect(await slashToggle.getAttribute('aria-pressed')).toBe('false')

    await slashToggle.click()
    // The toggle reflects selected state optimistically.
    await expect(slashToggle).toHaveAttribute('aria-pressed', 'true')
    // The PUT persists the new selection containing the slash id.
    await expect
      .poll(() => JSON.stringify(prefsPuts()), {
        message: 'expected a PUT /api/prefs/quick_keys containing slash:/compact',
      })
      .toContain('slash:/compact')
  })

  test('the redundant title-bar dots are gone (bottom session pill stays)', async ({
    page,
  }) => {
    await installMocks(page)
    await gotoFocus(page)

    // The old header "···" had aria-label "More" — it must no longer exist.
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)

    // The bottom-left session switcher (the pill showing the session name) stays
    // and still opens the picker.
    const pill = page.getByRole('button', { name: new RegExp(SESSION) }).first()
    await expect(pill).toBeVisible()
  })
})
