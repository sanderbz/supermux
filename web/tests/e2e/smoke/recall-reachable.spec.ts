// Prompt recall is reachable on a session supermux never submitted through.
//
// THE DEFECT. Both the "Show prompt history" trigger and the ⌘G binding were
// gated on `hasLastSend` — supermux's own `last_send_text` column, which is
// only written when supermux ITSELF submits a prompt. A session that has been
// driven from the terminal, or resumed, or created outside the composer has an
// empty column and a full history: GET /recall returns real entries while the
// UI offers no way in, and ⌘G is a silent no-op. Six of the verification rig's
// sessions were in exactly that state.
//
// The gate is now the SESSION, and the panel owns its own empty state ("No
// prompts yet."), which is the honest thing to show for a session that really
// has no history — as opposed to hiding the surface and telling the user
// nothing.

import { expect, test } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend } from './harness'

test.describe('prompt recall', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('opens on a session with no last_send — by button and by ⌘G', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.addInitScript(injectGlobals(backend.token))

    const A = api(backend)
    const created = await A.createSession({
      name: 'recall-none',
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(created.status, 'create shell session').toBe(201)
    expect((await A.startSession('recall-none')).ok).toBeTruthy()

    // The precondition this test is about: the row carries NO last send. If a
    // future change starts seeding the column, this assertion fails loudly
    // rather than letting the test quietly stop proving anything.
    // `GET /api/sessions` answers `{ data: [...] }` (the client's own
    // `asSessions` tolerates both shapes).
    const listed = (await (await A.listSessions()).json()) as
      | { name: string; last_send_text?: string | null }[]
      | { data: { name: string; last_send_text?: string | null }[] }
    const rows = Array.isArray(listed) ? listed : listed.data
    const row = rows.find((s) => s.name === 'recall-none')
    expect(row, 'the session is on the wire').toBeTruthy()
    expect(row!.last_send_text ?? '', 'the session has no last_send').toBe('')

    await page.goto(`${backend.baseUrl}/focus/recall-none`)
    await expect(
      page.getByRole('application', { name: 'Live terminal for recall-none' }),
    ).toBeVisible({ timeout: 20_000 })

    // ── the trigger EXISTS ──────────────────────────────────────────────────
    const trigger = page.getByRole('button', { name: /Show prompt history/ })
    await expect(trigger).toBeVisible({ timeout: 10_000 })

    // ── and it opens the panel ──────────────────────────────────────────────
    await trigger.click()
    const panel = page.getByRole('dialog', { name: 'Prompt history' })
    await expect(panel).toBeVisible({ timeout: 10_000 })
    // The panel's own honest empty state, not a hidden surface.
    await expect(panel.getByText(/No prompts yet\.|just now|ago/)).toBeVisible({
      timeout: 10_000,
    })
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden({ timeout: 10_000 })

    // ── ⌘G is live too ──────────────────────────────────────────────────────
    // It was bound only when a last send existed, so on this session the key
    // did nothing at all.
    await page.keyboard.press('Meta+g')
    await expect(panel).toBeVisible({ timeout: 10_000 })
  })
})
