/**
 * The delivery receipt an unconfirmed send wears (fase A4 T7 companion).
 * ─────────────────────────────────────────────────────────────────────────────
 * "Sending…" stops being true the moment the POST returns — the app is not
 * sending any more, it is waiting. `deliveryLine` says what it is waiting for,
 * out of the one piece of evidence this branch has: the server's own
 * `set_last_send` receipt, written after the paste and the Enter. Claude Code's
 * richer `queue-operation` receipt does not reach this client here (see the
 * function's own comment), and the row states what it can prove rather than
 * drawing a queue position it cannot.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ChatConversation } from '../../src/components/chat/conversation'
import { deliveryLine, type PendingSend } from '../../src/components/chat/pending'
import type { TileSession } from '../../src/components/session-tile/types'

const session: TileSession = {
  name: 'release-train',
  display_name: 'Release Train',
  status: 'active',
} as TileSession

describe('what an unconfirmed send says', () => {
  const send = (extra: Partial<PendingSend> = {}): PendingSend => ({
    id: 'p1',
    text: 'run the tests',
    atMs: 1_000,
    state: 'unconfirmed',
    ...extra,
  })

  test('before the server confirms anything, it is still just sending', () => {
    expect(deliveryLine(send(), { active: false })).toBe('Sending…')
  })

  test('once the server says it typed the text, the row states the receipt', () => {
    expect(deliveryLine(send({ receipted: true }), { active: false })).toMatch(
      /the session has it/i,
    )
  })

  test('mid-turn, it names the turn the message is queued behind', () => {
    expect(deliveryLine(send({ receipted: true }), { active: true })).toMatch(/queued behind/i)
  })

  test('the surface renders the receipt, not a bare spinner', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={session}
        items={[]}
        nowMs={0}
        turnStart={null}
        pending={[send({ receipted: true })]}
      />,
    )
    expect(html).toContain('data-receipted="true"')
    expect(html).toMatch(/queued behind/i)
    expect(html).not.toContain('Sending…')
  })
})
