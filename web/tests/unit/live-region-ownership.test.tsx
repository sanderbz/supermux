/**
 * One state, one voice — asserted over the ASSEMBLED surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * `chat-a11y.test.tsx` already pins that the live LAYER announces a turn once.
 * It could never have caught the actual defect, because it renders one
 * component: sampling every `[aria-live]:not(off)` on the running product
 * during a real turn found THREE regions changing inside the same 500 ms
 * window —
 *
 *   1. the recall strip   "You · just now “…”"      (the user's own text)
 *   2. the pending band   the same text again + "The session has it…"
 *   3. the LiveAnnouncer  "Claude is working."
 *
 * — so the user's message was read back twice before anything was said about
 * the reply, against T7.1's "ONE announcement per turn". Separately the global
 * `ReconnectBanner` and the chat connection chip are two un-nested polite
 * regions both saying "Reconnecting…".
 *
 * The guard therefore has to be a COUNT ACROSS COMPONENTS, which is what this
 * file is: render the pieces that genuinely co-exist on a focus route and count
 * the regions that would speak. A component that quietly grows an `aria-live`
 * later fails here even though its own test file stays green.
 *
 * (`renderToStaticMarkup`, like the rest of `tests/unit` — the repo has no DOM
 * environment. The connection half of the story is asserted through the
 * ownership module directly, since SSR by definition has nothing mounted.)
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { PendingEchoes } from '../../src/components/chat/conversation'
import { LiveLayer } from '../../src/components/chat/live-layer'
import { LastSendBar } from '../../src/components/focus-mode/last-send-recall'
import {
  claimConnectionVoice,
  connectionVoiceClaims,
} from '../../src/lib/live-region-owner'
import type { PendingSend } from '../../src/components/chat/pending'
import type { TileSession } from '../../src/components/session-tile/types'

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>)

/** Count of regions that would actually speak. `aria-live="off"` is silent, and
 *  so is a bare `role="status"` whose politeness has been switched off. */
function speakingRegions(markup: string): number {
  return (markup.match(/aria-live="(?:polite|assertive)"/g) ?? []).length
}

function session(over: Partial<TileSession> = {}): TileSession {
  return { name: 'release-train', status: 'active', updated_at: '', ...over } as TileSession
}

const pending = (state: PendingSend['state']): PendingSend =>
  ({
    id: 'p1',
    text: 'reply with the single word pong',
    state,
    sentAt: Date.now(),
  }) as PendingSend

/**
 * The three surfaces that are on screen together the instant after a send:
 * the recall strip under the header, the optimistic echo band, and the live
 * layer. This is the assembly the page-level sampling caught.
 */
function afterSend(state: PendingSend['state']) {
  return html(
    <>
      <LastSendBar
        sessionName="release-train"
        recall={{ text: 'reply with the single word pong', sentAt: new Date() }}
        onOpenRecall={() => {}}
      />
      <PendingEchoes pending={[pending(state)]} active />
      <LiveLayer name="release-train" session={session()} turnStart={1} />
    </>,
  )
}

describe('a turn is announced once, across the whole surface', () => {
  test('the ordinary path: exactly ONE region speaks, and it is the phase', () => {
    const markup = afterSend('unconfirmed')
    expect(speakingRegions(markup)).toBe(1)
    // …and it is the LiveAnnouncer, not one of the two echoes of the user's
    // own text.
    expect(markup).toContain('Claude is working.')
  })

  test('the same holds while the POST is still in flight', () => {
    expect(speakingRegions(afterSend('sending'))).toBe(1)
  })

  test('the recall strip never speaks — the user typed it', () => {
    const markup = html(
      <LastSendBar
        sessionName="release-train"
        recall={{ text: 'hello', sentAt: new Date() }}
        onOpenRecall={() => {}}
      />,
    )
    expect(speakingRegions(markup)).toBe(0)
    // Still fully reachable, just not spoken unprompted.
    expect(markup).toContain('aria-label="You said')
  })

  test('THE EXCEPTION: an undelivered send is news, so the band speaks', () => {
    const markup = afterSend('undelivered')
    // Two: the phase, and the failure. This is the one state where a second
    // voice is the point — "this message did not land" is learned by NOT
    // getting what you asked for, so nothing else on screen says it.
    expect(speakingRegions(markup)).toBe(2)
    expect(html(<PendingEchoes pending={[pending('undelivered')]} />)).toContain(
      'aria-live="polite"',
    )
    // …and it is silent in every other state, which is what stops it
    // double-reading the message on the happy path.
    expect(html(<PendingEchoes pending={[pending('unconfirmed')]} />)).toContain(
      'aria-live="off"',
    )
  })

  test('an idle surface says nothing at all', () => {
    const markup = html(
      <>
        <PendingEchoes pending={[]} />
        <LiveLayer name="release-train" session={session({ status: 'idle' })} turnStart={null} />
      </>,
    )
    // The LiveAnnouncer's region is still mounted (a region that appears with
    // its text announces unreliably) — it is simply empty.
    expect(speakingRegions(markup)).toBe(1)
    expect(markup).not.toContain('Claude is working.')
  })
})

describe('connection has one owner too', () => {
  test('a claim is counted, released exactly once, and idempotent', () => {
    expect(connectionVoiceClaims()).toBe(0)
    const release = claimConnectionVoice()
    expect(connectionVoiceClaims()).toBe(1)
    // A second surface claiming does not silence the first when it leaves.
    const release2 = claimConnectionVoice()
    expect(connectionVoiceClaims()).toBe(2)
    release2()
    release2() // double-release must not underflow the count
    expect(connectionVoiceClaims()).toBe(1)
    release()
    expect(connectionVoiceClaims()).toBe(0)
  })
})
