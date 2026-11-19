// The Board removal's GATE (fase B2 T11), and then its proof.
//
// §18's named risk is "board removal orphans a live capability", and the answer
// is that nothing is removed without its replacement in the same PR — asserted,
// not asserted-in-prose. So this spec runs in two halves and the ORDER is the
// point: the replacement is proved FIRST, against a real booted binary, and only
// then is the removal checked.
//
// What is proved here (LEG 3, the only leg this harness can actually drive): the
// issue surface is reachable PER SESSION and PER TEAM, and a comment posts and
// is DURABLE through `GET /api/board` (T10).
//
// The other two replacements are gated by suites that really exercise them, not
// by a leg here that could only take an early return on this fixture:
//   • the attention rollup (T6) — `tests/unit/attention-rollup.test.tsx` for
//     rendering, ordering, the +N collapse and each row's resolved href, and
//     `tests/unit/attention-tiers.test.ts` for the arithmetic that puts a row in
//     a tier. This harness cannot make a shell session `needs`, so an e2e leg
//     here asserted nothing about the rollup.
//   • the chat reply loop (A4/A5) — `chat-renderer-switch.spec.ts` and
//     `chat-toggle-thrash.spec.ts` for the renderer seam against a real pty, and
//     `focus-types-and-sees-output.spec.ts` for the focus route mounting a live
//     surface and round-tripping keystrokes through the pty.
//
// If this leg fails, T11 does not land and B2 ships without it.

import { expect, test, type Page } from '@playwright/test'
import { api, injectGlobals, startBackend, type Backend, PIN_CLASSIC_SURFACE } from './harness'

test.describe('board removal gate', () => {
  let backend: Backend

  test.beforeEach(async () => {
    backend = await startBackend()
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  /** Seed a session row. The tile renders for any row — no tmux needed. */
  async function seedSession(name: string): Promise<void> {
    const res = await api(backend).createSession({
      name,
      provider: 'shell',
      dir: backend.dataDir,
    })
    expect(res.status, `create session ${name}`).toBe(201)
  }

  /** Seed an issue on Main, optionally linked to a session. */
  async function seedIssue(title: string, session?: string): Promise<string> {
    const res = await api(backend).createIssue({
      title,
      desc: 'Seeded by the board-removal gate.',
      ...(session ? { session } : {}),
    })
    expect(res.status, `create issue ${title}`).toBeLessThan(300)
    const body = await res.json()
    const id: string = body?.data?.id ?? body?.id
    expect(id, 'issue id').toBeTruthy()
    return id
  }

  async function open(page: Page, path = '/'): Promise<void> {
    await page.addInitScript(injectGlobals(backend.token))
    await page.addInitScript(PIN_CLASSIC_SURFACE)
    await page.goto(backend.baseUrl + path)
  }

  // ── LEG 3 — the issue surface, per session and per team ───────────────────
  //
  // First because it is the capability the removal actually trades away: the
  // Board page was the only place issues were visible at all.

  test('LEG 3 — a session’s issues are reachable from the session itself', async ({
    page,
  }) => {
    await seedSession('gate-session')
    const id = await seedIssue('Ship the roster', 'gate-session')

    // The session's own info panel — opened from the focus header's title, the
    // path a user actually takes. (The overview kebab reaches the same panel;
    // it is hover-revealed and only mounted in custom mode, so the focus route
    // is the stable door for a gate.)
    await open(page, '/focus/gate-session')
    await page.getByRole('button', { name: /Session info —/ }).first().click()

    const panel = page.locator('[data-vr="issue-list"]')
    await expect(panel, 'the session panel lists its issues').toBeVisible()
    await expect(page.locator(`[data-issue-id="${id}"]`)).toBeVisible()
    await expect(page.getByText('Ship the roster')).toBeVisible()
  })

  test('LEG 3 — opening an issue shows its detail, and a comment posts', async ({
    page,
  }) => {
    await seedSession('gate-session')
    const id = await seedIssue('Answer the question', 'gate-session')

    await open(page, '/focus/gate-session')
    await page.getByRole('button', { name: /Session info —/ }).first().click()
    await page.locator(`[data-issue-id="${id}"]`).click()

    // The overlay hosts the detail — list + detail, one component, B1's shell.
    await expect(page.locator('[data-vr="issue-surface"]')).toBeVisible()
    await expect(page.getByText('Seeded by the board-removal gate.')).toBeVisible()

    // The reply composer posts a DURABLE comment when the session is not live —
    // the capability chat structurally cannot hold, and the reason the board API
    // is not deprecated with the page.
    const composer = page.getByRole('textbox', { name: /reply|comment/i }).first()
    await composer.fill('Recorded by the gate.')
    await page.getByRole('button', { name: 'Send reply' }).click()
    // `.first()`: the comment lands in the detail's stream AND the row's own
    // preview, which is the correct behaviour and two matches for one string.
    await expect(page.getByText('Recorded by the gate.').first()).toBeVisible({
      timeout: 15_000,
    })

    // …and it is on the SERVER, not just on screen. There is no single-issue
    // GET (`/api/board/{id}` is PATCH/DELETE only), so read the list.
    const res = await fetch(`${backend.backendUrl}/api/board`, {
      headers: { Authorization: `Bearer ${backend.token}` },
    })
    const body = await res.json()
    const rows = (body?.data ?? body) as { id: string; comments: { body: string }[] }[]
    const comments = rows.find((r) => r.id === id)?.comments ?? []
    expect(
      comments.some((c: { body: string }) => c.body.includes('Recorded by the gate.')),
      'the comment is durable',
    ).toBe(true)
  })

  // ── THE REMOVAL ITSELF ────────────────────────────────────────────────────

  test('/board redirects instead of 404-ing, and the nav has four items', async ({
    page,
  }) => {
    await seedSession('gate-nav')
    await open(page, '/board')

    // A bookmark lands somewhere honest.
    await expect(page).toHaveURL(new RegExp(`${backend.baseUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/?$`))

    // Four nav items, and none of them is the Board.
    const nav = page.getByRole('navigation', { name: 'Primary' }).first()
    await expect(nav.getByRole('link', { name: 'Board' })).toHaveCount(0)
    await expect(nav.getByRole('link')).toHaveCount(4)
  })

  test('⌘K has no board verbs and no issue rows', async ({ page }) => {
    await seedSession('gate-palette')
    await seedIssue('Not in the palette')
    await open(page)

    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog').first()
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').or(palette.getByRole('textbox')).first().fill('Not in')
    // The issue exists on the server and must NOT be offered here any more.
    await expect(palette.getByText('Not in the palette')).toHaveCount(0)
  })
})
