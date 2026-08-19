/**
 * The take-the-wheel card — what the human is told, and what stays shut.
 *
 * The failure this card exists to fix is an agent parked forever behind a login
 * it cannot pass. The failure it must not INTRODUCE is the panel — a canvas, a
 * decoder and a live WebSocket to the agent's browser — mounting for every turn
 * that merely MENTIONS a takeover. So both are asserted: the ask is rendered in
 * the agent's own words with the session it belongs to, and the panel is absent
 * until someone actually takes the wheel.
 *
 * The reason string is the AGENT's text. It is rendered as plain text, never as
 * markup, for exactly the reason the elicitation card asserts the same thing.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { TakeoverCard } from '../../src/components/chat/ui/takeover-card'
import type { BrowserTakeoverInfo } from '../../src/lib/api/sessions'

const ask = (over: Partial<BrowserTakeoverInfo> = {}): BrowserTakeoverInfo => ({
  session: 'alice',
  reason: 'sign in to bank.example and approve the 2FA push',
  ...over,
})

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)

describe('the card says who needs what', () => {
  test('it names the bot, the eyebrow and the agent’s own sentence', () => {
    const out = html(<TakeoverCard ask={ask()} botName="alice" />)
    expect(out).toContain('Shared browser')
    expect(out).toContain('alice needs you to take the wheel')
    expect(out).toContain('sign in to bank.example and approve the 2FA push')
  })

  test('it falls back to the session slug when no display name is given', () => {
    const out = html(<TakeoverCard ask={ask({ session: 'scout-2' })} />)
    expect(out).toContain('scout-2 needs you to take the wheel')
  })

  test('the agent’s sentence is TEXT, never markup', () => {
    const out = html(<TakeoverCard ask={ask({ reason: '<img src=x onerror=alert(1)>' })} />)
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img src=x')
  })

  test('it says what the takeover means for the agent', () => {
    const out = html(<TakeoverCard ask={ask()} />)
    expect(out).toContain('hand back')
  })
})

describe('the panel stays shut until someone takes the wheel', () => {
  test('closed: an offer, and no takeover surface at all', () => {
    const out = html(<TakeoverCard ask={ask()} />)
    expect(out).toContain('Take the wheel')
    expect(out).not.toContain('takeover-overlay')
    expect(out).not.toContain('role="dialog"')
  })

  test('open: the overlay is a labelled modal with a hand-back out', () => {
    const out = html(<TakeoverCard ask={ask()} botName="alice" defaultOpen />)
    expect(out).toContain('takeover-overlay')
    expect(out).toContain('role="dialog"')
    expect(out).toContain('aria-modal="true"')
    expect(out).toContain('Hand back')
    // The panel itself is lazy — the shell renders its fallback, not a socket.
    expect(out).toContain('Opening the agent')
  })
})
