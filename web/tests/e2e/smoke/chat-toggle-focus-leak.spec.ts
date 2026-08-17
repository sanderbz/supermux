// The keystroke leak — the worst failure the renderer toggle ever shipped.
//
// WHAT HAPPENED. Toggle to Terminal, toggle back to Chat, click the composer,
// type a sentence. Focus dropped to `<body>` a few milliseconds after the
// click; the leading characters vanished; the first `t` reached the GLOBAL
// renderer hotkey and flipped the surface back to Terminal; and every remaining
// character was typed into the live agent's pty. A message meant for a chat
// composer was executed as terminal input, trailing Enter included.
//
// THREE DEFECTS COMPOUNDED, and the fix is three guards:
//
//   (a) `renderer-shell.tsx` — the hidden Pane fired `onHidden` on EVERY run of
//       its effect while hidden, and both call sites pass a fresh inline arrow
//       per render, so an unrelated re-render re-fired it. It is now an EDGE.
//   (b) `use-live-term.ts` — `blur()` called `document.activeElement.blur()`
//       unconditionally, so the retained terminal's handle evicted focus from
//       anywhere on the page, the composer included. It is now containment-
//       checked against the terminal's own container.
//   (c) `chat/arm-composer-focus.ts` — only the TERMINAL direction of the
//       toggle ever armed focus, so the chat surface was never keyboard-usable
//       at all: `document.activeElement` was `<body>`, which is precisely where
//       the renderer hotkey listens.
//
// WHY THIS IS AN E2E. All three are effects over real focus, and there is no
// DOM in this repo's unit runner. The pty half cannot be faked either: the only
// honest proof that nothing leaked is asking the SERVER what the pane received.
//
// Needs server/target/debug/supermux-server — `cd server && cargo build`
// first (debug; never --release).

import { expect, test } from '@playwright/test'

import { CHAT_BACKEND_ENV, chatSession, expectTokenOnce, primePage } from './chat-fixture'
import { startBackend, type Backend } from './harness'

const CONV = 'leak-conv'
/** The probe. It STARTS WITH `t` on purpose: `t` is the global renderer hotkey,
 *  so a probe that leaks does not merely land in the wrong box — it flips the
 *  surface first and then types into the pty. Every character is also unique
 *  enough to grep a pty capture for. */
const PROBE = 'the composer owns this sentence'

test.describe('the renderer toggle never leaks keystrokes into the pty', () => {
  let backend: Backend
  test.beforeEach(async () => {
    backend = await startBackend({ env: CHAT_BACKEND_ENV })
  })
  test.afterEach(async () => {
    await backend?.dispose()
  })

  test('chat → terminal → chat: the caret is in the composer and the pty sees nothing', async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const fx = await chatSession(backend, 'leak')
    fx.write(CONV, ['LEAK-SEED-0001'])
    await fx.hook(CONV)

    await primePage(page, backend)
    await page.goto(`${backend.baseUrl}/focus/${fx.name}`)

    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expectTokenOnce(page, 'LEAK-SEED-0001')
    await expect(page.getByTestId('chat-composer-field')).toBeVisible()

    // ── the toggle, both ways ───────────────────────────────────────────────
    await page.getByTestId('renderer-terminal').click()
    await expect(page.locator('.xterm')).toBeVisible()
    await page.getByTestId('renderer-chat').click()
    await expect(page.getByTestId('chat-panel')).toBeVisible()

    // GUARD (c). The surface the user just asked for owns the caret. Before the
    // fix this was BODY — which is why the very first character went to the
    // document's hotkey handler instead of into the message.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.getAttribute('data-testid') ?? 'none',
          ),
        { timeout: 10_000, message: 'a toggle to Chat must leave the caret in the composer' },
      )
      .toBe('chat-composer-field')

    // ── type, the way a person does ─────────────────────────────────────────
    // Click first (the reported repro), then type with real key events. The
    // click is what re-rendered the tree and re-fired the hidden pane's
    // `onHidden` → `term.blur()` → page-wide focus eviction.
    await page.getByTestId('chat-composer-field').click()
    await page.keyboard.type(PROBE, { delay: 12 })

    // GUARDS (a) + (b). Every character is in the composer: none dropped while
    // focus was being evicted, and none consumed by the hotkey.
    await expect(page.getByTestId('chat-composer-field')).toHaveValue(PROBE)

    // The surface never flipped. `t` reaching the document is the tell.
    await expect(page.getByTestId('chat-panel')).toBeVisible()
    await expect(page.locator('.xterm')).toBeHidden()

    // ── and the pane received nothing ───────────────────────────────────────
    // The authority on what the pty got is the server, not the DOM. The
    // fixture's pane is a bare `bash`, so a leaked probe would sit on its
    // prompt (or, with the trailing Enter the original repro produced, in its
    // output as a `command not found`).
    const peek = await fetch(
      `${backend.backendUrl}/api/sessions/${fx.name}/peek?lines=60`,
      { headers: { Authorization: `Bearer ${backend.token}` } },
    )
    expect(peek.ok).toBeTruthy()
    const body = JSON.stringify(await peek.json())
    expect(body, 'a message typed into the composer must never reach the pty').not.toContain(
      PROBE,
    )
    // …and not even a fragment of it. The leak dropped leading characters, so
    // the tail is what actually landed in the pty.
    expect(body).not.toContain('composer owns this')
  })
})
