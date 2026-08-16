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
    // A turn that was ALREADY running when Enter was pressed — the only case in
    // which "queued behind that turn" is a true sentence.
    expect(
      deliveryLine(send({ receipted: true, activeAtSend: true }), { active: true }),
    ).toMatch(/queued behind/i)
  })

  /**
   * THE SELF-ATTRIBUTION (daily-driver QA #10).
   *
   * Sent into an IDLE session, the row read "waiting for the transcript to catch
   * up" at 109ms and flipped to "Claude is mid-turn, so it's queued behind the
   * running turn" at 228ms — because the status had gone active in between, and
   * the turn it now claimed to be queued behind was itself. Two sentences, one
   * state, and the second one false.
   */
  test('a send into an IDLE session is never queued behind itself', () => {
    const p = send({ receipted: true, activeAtSend: false })
    // The status has flipped by the time this renders: that is the whole bug.
    expect(deliveryLine(p, { active: true })).toMatch(/waiting for the transcript/i)
    // And it does not change again once the turn is under way.
    expect(deliveryLine(p, { active: true })).toBe(deliveryLine(p, { active: false }))
  })

  test('the surface renders the receipt, not a bare spinner', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        name="release-train"
        session={session}
        items={[]}
        nowMs={0}
        turnStart={null}
        pending={[send({ receipted: true, activeAtSend: true })]}
      />,
    )
    expect(html).toContain('data-receipted="true"')
    expect(html).toMatch(/queued behind/i)
    expect(html).not.toContain('Sending…')
  })
})
