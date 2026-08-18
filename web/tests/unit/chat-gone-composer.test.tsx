/**
 * The dead-session surface — composer AND chip (showcase honesty wave, W9).
 * ─────────────────────────────────────────────────────────────────────────────
 * The jury caught the `st-gone-no-session` / `st-gone-unavailable` shots
 * rendering a DELETED session as a full healthy transcript under a LIVE
 * `Message …` composer, with the only signal a low-contrast grey chip. The
 * triage found the split:
 *
 *   · THE COMPOSER was a STALE BENCH. `chat-panel.tsx` has gated it since
 *     wave-7 (`blocked={tail.gone !== null ? CHAT_GONE[tail.gone].detail : …}`),
 *     but `/dev/chat-live` drove `gone` into the header chip ONLY, so the
 *     `idle` board the shots ride fell through to `ChatConversation`'s
 *     read-only-shell fallback — a plain `Message …` pill, ungated. The bench,
 *     not the product, was the lie. The fix threads `gone` through `Surface`
 *     into a real `<ChatComposer>`, exactly as the panel does.
 *
 *   · THE CHIP was a REAL product gap. `CHAT_GONE['no-session'].alarming` was
 *     authored `true` and then read by NOTHING: `ConnectionNote` washed every
 *     state — a recoverable reconnect and a terminal deletion alike — in the
 *     same neutral grey. A deletion now borrows the composer's calm
 *     `status-error` palette so "gone for good" cannot read as metadata;
 *     `chat-unavailable` (`alarming:false`, a session that simply has no chat
 *     plane) stays calm, because it is not a fault.
 *
 * Both assertions would have gone red on the shot the jury reviewed.
 */

import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectionNote } from '../../src/components/chat/connection-note'
import { CHAT_GONE } from '../../src/components/chat/connection'
import { Surface } from '../../src/routes/dev-chat-live'
import { liveStates } from '../../src/routes/dev-chat-live.fixture'

const NOW = 1_760_000_000_000
const idle = liveStates(NOW).find((s) => s.id === 'idle')!

/* ── the bench now shows the SHIPPED gated composer over a gone pointer ────── */

describe('a gone pointer gates the bench composer (the st-gone-* stale-fixture fix)', () => {
  test('idle has NO composer spec — the fallback shell was the ungated pill the jury saw', () => {
    // The root cause in one assertion: the board the shots ride carries no
    // composer of its own, so before the fix `Surface` handed
    // `ChatConversation` `undefined` and it drew the read-only `Message …`
    // shell — which has no concept of a dead pointer.
    expect(idle.composer).toBeUndefined()
  })

  test('no-session → a read-only composer that says why, not an invitation to type', () => {
    const html = renderToStaticMarkup(
      <Surface state={idle} nowMs={NOW} surface="desktop" gone="no-session" />,
    )
    // The shipped blocked strip, with the terminal reason as its sentence.
    expect(html).toContain('data-testid="chat-composer-blocked"')
    expect(html).toContain(CHAT_GONE['no-session'].detail)
    expect(html).toContain('This session no longer exists.')
    // READ-ONLY, not a live field — the whole honesty point. The field keeps
    // its draft selectable (`readOnly`, not `disabled`) and announces itself
    // inert.
    expect(html).toContain('readOnly')
    expect(html).toContain('aria-disabled="true"')
  })

  test('chat-unavailable → also gated, and points at the terminal', () => {
    const html = renderToStaticMarkup(
      <Surface state={idle} nowMs={NOW} surface="desktop" gone="chat-unavailable" />,
    )
    expect(html).toContain('data-testid="chat-composer-blocked"')
    // Substring only — the full detail carries an apostrophe the SSR escapes.
    expect(html).toContain('available for this session')
    expect(html).toContain('aria-disabled="true"')
  })

  test('WITHOUT gone the idle board draws no blocked strip — the control', () => {
    const html = renderToStaticMarkup(
      <Surface state={idle} nowMs={NOW} surface="desktop" gone={null} />,
    )
    expect(html).not.toContain('data-testid="chat-composer-blocked"')
    // …and it is the read-only-shell fallback that draws instead, so a live
    // board is unchanged: the gate is driven by `gone` and nothing else.
    expect(html).toContain('Message ')
  })

  test('the phone surface gates the composer too — the shots are dark desktop AND phone', () => {
    const html = renderToStaticMarkup(
      <Surface state={idle} nowMs={NOW} surface="phone" gone="no-session" />,
    )
    expect(html).toContain('data-testid="chat-composer-blocked"')
    expect(html).toContain('aria-disabled="true"')
  })
})

/* ── the chip stops reading a terminal deletion as calm metadata ──────────── */

describe('ConnectionNote escalates an ALARMING terminal close (the real product fix)', () => {
  const render = (props: React.ComponentProps<typeof ConnectionNote>) =>
    renderToStaticMarkup(<ConnectionNote {...props} />)

  test('no-session wears the not-healthy status-error wash, not the neutral grey', () => {
    const html = render({ state: 'offline', gone: 'no-session' })
    expect(CHAT_GONE['no-session'].alarming).toBe(true)
    expect(html).toContain('status-error')
    // It must NOT keep the neutral wash the recoverable states use.
    expect(html).not.toContain('bg-fill-soft')
    expect(html).toContain('data-gone="no-session"')
    expect(html).toContain('Session deleted')
  })

  test('chat-unavailable stays CALM — a session with no chat plane is not a fault', () => {
    const html = render({ state: 'offline', gone: 'chat-unavailable' })
    expect(CHAT_GONE['chat-unavailable'].alarming).toBe(false)
    expect(html).not.toContain('status-error')
    expect(html).toContain('bg-fill-soft')
  })

  test('a recoverable reconnect keeps the neutral grey — only a DEAD state escalates', () => {
    const html = render({ state: 'reconnecting' })
    expect(html).not.toContain('status-error')
    expect(html).toContain('bg-fill-soft')
  })
})
