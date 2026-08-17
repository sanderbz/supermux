// "Chat is on screen and nothing owns the caret" must not be a reachable state.
//
// The sibling spec (`chat-toggle-focus-leak.spec.ts`) covers ONE path into that
// state: the renderer toggle itself. Two more were found live, and both end the
// same way — the sentence the user typed at a chat surface is executed in the
// agent's pty:
//
//   (1) DESKTOP, BACKGROUND CLICK. Click the empty transcript background and the
//       caret leaves the composer for a non-focusable div. The composer is only
//       ever re-armed on the `[name, chatActive]` EDGE, so nothing takes it
//       back; the first `t` of the next sentence reaches the global renderer
//       hotkey, flips the surface to Terminal, and the rest is typed at `❯`.
//
//   (2) COARSE POINTER, TERMINAL → CHAT. `useArmComposerFocus` is exempt on
//       `pointer: coarse` (focusing a textarea summons the soft keyboard, which
//       nobody asked for by tapping a switch) — but the EXEMPTION WAS APPLIED TO
//       THE EVICTION TOO: the retained terminal kept DOM focus behind the
//       crossfade, so every key still went to xterm's helper textarea while the
//       chat surface was the only thing on screen.
//
// WHAT THE ASSERTIONS ARE. `document.activeElement` CANNOT be trusted here: a
// focused element inside an `inert` subtree reports as `<body>` while still
// receiving every keydown. So each test records the real `event.target` of the
// keys it types, and then asks the SERVER what the pane received.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { expect, test, type Page } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, expectTokenOnce, primePage } from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV = 'evict-conv'
/** Starts with `t` on purpose — `t` is the global renderer hotkey, so a probe
 *  that leaks flips the surface first and types into the pty second. */
const PROBE = 'the composer still owns this sentence'

/** Record the `event.target` of every keydown, in capture phase, so the test can
 *  read where the keys REALLY went (activeElement lies inside `inert`). */
async function recordKeyTargets(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keyTargets?: string[] }
    w.__keyTargets = []
    document.addEventListener(
      'keydown',
      (e) => {
        const el = e.target as HTMLElement | null
        const id = el?.getAttribute?.('data-testid')
        w.__keyTargets!.push(
          `${el?.tagName ?? 'NONE'}${id ? `#${id}` : ''}${el?.closest?.('.xterm') ? '@xterm' : ''}`,
        )
      },
      true,
    )
  })
}

async function keyTargets(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __keyTargets?: string[] }).__keyTargets ?? [],
  )
}

async function peekBody(backend: Backend, name: string): Promise<string> {
  const peek = await fetch(`${backend.backendUrl}/api/sessions/${name}/peek?lines=60`, {
    headers: { Authorization: `Bearer ${backend.token}` },
  })
  expect(peek.ok).toBeTruthy()
  return JSON.stringify(await peek.json())
}

test.describe('the chat surface keeps the keyboard after a background click', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('clicking the transcript background does not hand the keys to the pty', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'evict')
    fx.write(CONV, ['EVICT-SEED-0001'])
    await fx.hook(CONV)

    await primePage(page, backend)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, 'EVICT-SEED-0001')
    await expect(page.getByTestId('chat-composer-field')).toBeVisible()

    // The reported repro: one click on the empty transcript background. The
    // scroll region is a plain div, so the click drops the caret on nothing.
    const region = page.locator('[data-testid="chat-panel"] [role="region"]')
    const box = await region.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width - 24, box!.y + box!.height / 2)

    await recordKeyTargets(page)
    await page.keyboard.type(PROBE, { delay: 12 })

    // Every key landed in the composer — not on the document, not at a pty.
    const targets = await keyTargets(page)
    expect(targets.length).toBeGreaterThan(0)
    expect(
      targets.filter((t) => t !== 'TEXTAREA#chat-composer-field'),
      'every key typed at a visible chat surface belongs to the composer',
    ).toEqual([])

    await expect(page.getByTestId('chat-composer-field')).toHaveValue(PROBE)
    // The surface never flipped: `t` reaching the document is the tell.
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.locator('.xterm')).toBeHidden()

    const body = await peekBody(backend, fx.name)
    expect(body, 'a message typed into the composer must never reach the pty').not.toContain(
      PROBE,
    )
    expect(body).not.toContain('composer still owns')
  })
})

test.describe('coarse pointer — the toggle to Chat still evicts the terminal', () => {
  // Not `devices['iPhone 14 Pro']`: that preset carries
  // `defaultBrowserType: 'webkit'`, which Playwright refuses inside a describe.
  // What the bug needs is the POINTER, and these three are what produce
  // `pointer: coarse` + touch on the chromium project this suite runs.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('terminal → chat on touch: the xterm textarea no longer owns the keys', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'evictm')
    fx.write(CONV, ['EVICT-SEED-0002'])
    await fx.hook(CONV)

    await primePage(page, backend)
    // `primePage` pins the DESKTOP seam's 1280×800 — take it back, or this test
    // measures the desktop route with a touch pointer instead of the phone one.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, 'EVICT-SEED-0002')

    // Tap to the terminal (which focuses xterm), then back to chat.
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await page.locator('.xterm-screen').click()
    await page.getByTestId('renderer-chat').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    await recordKeyTargets(page)
    await page.keyboard.type(PROBE, { delay: 12 })

    // The coarse-pointer exemption may skip FOCUSING the composer — it may
    // never skip UNFOCUSING the terminal.
    const targets = await keyTargets(page)
    expect(targets.length).toBeGreaterThan(0)
    expect(
      targets.filter((t) => t.includes('@xterm')),
      'a hidden terminal must not receive keys typed at a visible chat surface',
    ).toEqual([])

    await expect(page.getByTestId('chat-panel')).toBeVisible()

    const body = await peekBody(backend, fx.name)
    expect(body, 'keys typed at the chat surface must never reach the pty').not.toContain(
      'still owns this sentence',
    )
  })
})
