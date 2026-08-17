/**
 * The blocked-session surface (states audit).
 *
 * The verify matrix's six `wrong` verdicts all describe the same screenshot: a
 * session that has hit a usage limit rendering as a healthy idle one — Claude's
 * banner drawn as an ordinary speech bubble, a green dot, a live composer, and
 * the reset time nowhere at all. These are the assertions that would have gone
 * red on that build.
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  blockedComposerNote,
  blockedState,
  lensBlockedAsBlockedState,
} from '../../src/components/chat/blocked'
import type { PtyNotice } from '../../src/components/chat/peek-lens'
import { attentionCopy, topAttention } from '../../src/components/chat/attention'
import type { ChatEntry } from '../../src/components/chat/entries'
import { toDisplayList } from '../../src/components/chat/entries'
import { buildTranscript } from '../../src/components/chat/grouping'
import { TranscriptItem } from '../../src/components/chat/transcript-item'

const banner = (over: Partial<ChatEntry> = {}): ChatEntry => ({
  uuid: 'b1',
  ts: 1_000,
  kind: 'blocked',
  text: "You've hit your session limit · resets 4:40am (Europe/Amsterdam)",
  label: 'Session limit',
  reply: 'Resets 4:40am (Europe/Amsterdam)',
  blocking: true,
  ok: false,
  ...over,
})

describe('blockedState — the fact that outlives the turn', () => {
  test('a blocking banner with nothing after it blocks the session', () => {
    const got = blockedState([banner()])
    expect(got?.label).toBe('Session limit')
    expect(got?.resets).toBe('Resets 4:40am (Europe/Amsterdam)')
  })

  test('a NEWER user prompt does NOT clear it', () => {
    // Typing into a rate-limited session is exactly what somebody does when
    // they have not noticed. Clearing on it would make the surface lie at the
    // one moment it matters. (Newest-first list: the prompt is index 0.)
    const entries: ChatEntry[] = [
      { uuid: 'p1', ts: 2_000, kind: 'prompt', text: 'are you there?' },
      banner(),
    ]
    expect(blockedState(entries)?.label).toBe('Session limit')
  })

  test('a newer assistant turn DOES clear it — the agent proved it can work', () => {
    const entries: ChatEntry[] = [
      { uuid: 'a1', ts: 3_000, kind: 'assistant', text: 'back online.' },
      banner(),
    ]
    expect(blockedState(entries)).toBeNull()
  })

  test('a transient failure is drawn but never blanks the composer', () => {
    // A 529 retry and a server-side throttle clear themselves, usually in
    // seconds — and CC says in the throttle's own copy that it is not a quota
    // hit. Gating the composer on those is an outage this app invented.
    for (const label of ['Server busy', 'API error']) {
      expect(blockedState([banner({ label, blocking: undefined })])).toBeNull()
    }
  })

  test('the composer note names the limit AND the clock', () => {
    expect(blockedComposerNote(blockedState([banner()])!)).toBe(
      'Session limit · resets 4:40am (Europe/Amsterdam)',
    )
    // A bucket answered by a slash command rather than a clock says only what
    // it knows.
    const credits = banner({ label: 'Usage credits', reply: undefined })
    expect(blockedComposerNote(blockedState([credits])!)).toBe('Usage credits')
  })
})

describe('lensBlockedAsBlockedState — the SECOND plane the composer gate must read', () => {
  // The states audit's residual: a session whose PTY shows the limit wall but
  // whose TRANSCRIPT carries no `blocked` banner (the turn ended on an ordinary
  // Stop). `blockedState` walks the transcript only, so it returns null and the
  // composer stayed live — promising delivery into a spent bucket while the
  // attention card and header chip already read the lens. This adapter is what
  // lets the ONE composer gate cover both planes.
  const limitNotice = (over: Partial<PtyNotice> = {}): PtyNotice => ({
    kind: 'limit-blocked',
    text: "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam)",
    ...over,
  })

  test('a lens-only limit-blocked notice becomes a composer-gating block', () => {
    const state = lensBlockedAsBlockedState(limitNotice())
    expect(state).not.toBeNull()
    // The verbatim CC line stands as the note — it already carries the bucket
    // and the clock, and the lens has no label/resets split to join.
    expect(blockedComposerNote(state!)).toBe(
      "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam)",
    )
  })

  test('only limit-blocked maps — a paused/refused notice is a different fact', () => {
    // These have their own cards (a modal to answer, a dead turn); they are not
    // a "you cannot send" wall, so they must NOT blank the composer.
    expect(lensBlockedAsBlockedState(limitNotice({ kind: 'session-paused' }))).toBeNull()
    expect(lensBlockedAsBlockedState(limitNotice({ kind: 'turn-refused' }))).toBeNull()
    expect(lensBlockedAsBlockedState(null)).toBeNull()
    expect(lensBlockedAsBlockedState(undefined)).toBeNull()
  })

  test('the transcript plane WINS when both planes see a block', () => {
    // `chat-panel` feeds the gate `wireBlocked ?? lensBlockedAsBlockedState(...)`:
    // the transcript banner carries the labelled/clocked split, so it is the
    // richer sentence when present. The lens only fills the silence.
    const wire = blockedState([banner()])
    const chained = wire ?? lensBlockedAsBlockedState(limitNotice())
    expect(chained).toBe(wire)
    expect(blockedComposerNote(chained!)).toBe(
      'Session limit · resets 4:40am (Europe/Amsterdam)',
    )
  })
})

describe('the amber card', () => {
  test('is a card in the system voice, never a Claude bubble', () => {
    const [, node] = buildTranscript(toDisplayList([banner()]), {})
    const html = renderToStaticMarkup(<TranscriptItem node={node} name="vx-chat" />)
    expect(html).toContain('data-testid="chat-blocked"')
    expect(html).toContain('data-label="Session limit"')
    expect(html).toContain('You&#x27;ve hit your session limit')
    // The whole answer to "when can I work again".
    expect(html).toContain('Resets 4:40am (Europe/Amsterdam)')
  })

  test('a signed-out session is offered the surface that can actually fix it', () => {
    // `/login` is an OAuth paste flow that exists only in the pty, so the card
    // hands the user to the terminal rather than to a button that would lie.
    const signedOut = banner({
      label: 'Signed out',
      text: 'API Error: 401 Invalid API key · Please run /login',
      reply: undefined,
    })
    const [, node] = buildTranscript(toDisplayList([signedOut]), {})
    const html = renderToStaticMarkup(
      <TranscriptItem node={node} name="vx-chat" onOpenTerminal={() => {}} />,
    )
    expect(html).toContain('data-testid="chat-blocked-signin"')
  })

  test('a limit card offers no sign-in — the affordance is scoped to the one error it answers', () => {
    const [, node] = buildTranscript(toDisplayList([banner()]), {})
    const html = renderToStaticMarkup(
      <TranscriptItem node={node} name="vx-chat" onOpenTerminal={() => {}} />,
    )
    expect(html).not.toContain('chat-blocked-signin')
  })
})

describe('the attention causes', () => {
  test('a blocked agent outranks every other cause on this surface', () => {
    // The other causes are about what THIS APP cannot do; this one is about the
    // session being unable to work at all.
    expect(topAttention(['send-unconfirmed', 'agent-blocked', 'dialog-unmapped'])).toBe(
      'agent-blocked',
    )
    expect(topAttention(['transcript-stale', 'transcript-blind'])).toBe('transcript-blind')
  })

  test('the blocked card names the bucket and the clock', () => {
    const copy = attentionCopy('agent-blocked', {
      blockedLabel: 'Weekly limit',
      blockedResets: 'Resets Aug 17, 4am (Europe/Amsterdam)',
    })
    expect(copy.title).toContain('Weekly limit')
    expect(copy.body).toContain('Aug 17, 4am')
    // …and still reads as a sentence with neither fact present.
    expect(attentionCopy('agent-blocked').title.endsWith('.')).toBe(true)
  })

  test('the transcript-blind card explains an empty conversation instead of showing one', () => {
    const copy = attentionCopy('transcript-blind')
    expect(copy.body).toContain('transcript saving off')
    expect(copy.body).toContain('terminal')
  })
})
