/**
 * The Attention card (fase A4 T5) — the surface that admits things.
 * ─────────────────────────────────────────────────────────────────────────────
 * Three properties are pinned here, because each one is a way this card could
 * quietly stop being useful:
 *
 *   1. EVERY CAUSE SAYS ITS OWN THING. Five refusals sharing one apologetic
 *      sentence is the failure mode of every "something went wrong" dialog ever
 *      shipped — so the copy is a pure function and each cause is asserted to
 *      name what is actually true, and to offer the terminal.
 *   2. THE EVIDENCE IS REAL, OR IT IS ABSENT. The mini-view renders the a0
 *      capture's own colours through `lib/ansi`; a capture with nothing in it
 *      renders NOTHING rather than an empty black box that reads as a dead
 *      session (master plan §4.4's message-only degrade).
 *   3. THE WAY OUT IS ALWAYS THERE. Whatever the cause, the card carries an
 *      Open-terminal control — chat refusing an action is only honest if the
 *      surface that can still do it is one tap away.
 *
 * Static markup only (`renderToStaticMarkup`): the card is presentational, and
 * the whole unit net runs in `bun test` without a DOM.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ATTENTION_ORDER,
  attentionCopy,
  detailFor,
  topAttention,
  type AttentionCause,
} from '../../src/components/chat/attention'
import {
  AttentionCard,
  AttentionMiniView,
  AttentionOverlay,
  AttentionRow,
  miniLines,
} from '../../src/components/chat/attention-card'
import { ChatConversation } from '../../src/components/chat/conversation'
import type { PendingSend } from '../../src/components/chat/pending'
import type { TileSession } from '../../src/components/session-tile/types'

const DIR = join(import.meta.dir, '../fixtures/tui')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')

const NAME = 'release-train'

const SESSION: TileSession = {
  name: NAME,
  status: 'idle',
  provider: 'claude',
  dir: '/opt/projects/supermux',
} as unknown as TileSession

// ── 1. The copy ─────────────────────────────────────────────────────────────

describe('the honesty copy', () => {
  test('every cause has its own title and body — no shared apology', () => {
    const titles = new Set<string>()
    const bodies = new Set<string>()
    for (const cause of ATTENTION_ORDER) {
      const copy = attentionCopy(cause)
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.body.length).toBeGreaterThan(0)
      titles.add(copy.title)
      bodies.add(copy.body)
      // The two sentences every "friendly error" collapses into. Neither is a
      // fact about this session, and both are banned by name.
      expect(copy.title.toLowerCase()).not.toContain('something went wrong')
      expect(copy.body.toLowerCase()).not.toContain('oops')
    }
    expect(titles.size).toBe(ATTENTION_ORDER.length)
    expect(bodies.size).toBe(ATTENTION_ORDER.length)
  })

  test('a failed send names the two things it did not get', () => {
    const copy = attentionCopy('send-unconfirmed')
    expect(copy.title).toContain('didn’t reach the session')
    expect(copy.body).toContain('transcript')
    expect(copy.body).toContain('terminal')
  })

  test('an unmapped dialog says it will not guess, and points at the terminal', () => {
    const body = attentionCopy('dialog-unmapped').body
    expect(body).toContain('will not press a key')
    expect(body).toContain('Answer it in the terminal.')
  })

  test('a paused turn says what is waiting, and that chat will not spend money', () => {
    // Catalog `limit.overage_consent_dialog`: needs-input, billing consequence,
    // and the session sits there while every surface says Idle.
    const copy = attentionCopy('session-paused', {
      detail: 'Continue with Fable 5 on usage credits, or switch models.',
    })
    expect(copy.title.toLowerCase()).toContain('paused')
    expect(copy.body).toContain('usage credits')
    expect(copy.body).toContain('spends credits on your account')
    expect(copy.body).toContain('terminal')
  })

  test('a refusal is not a rate limit and not a retry — and says so', () => {
    const copy = attentionCopy('turn-refused', {
      detail: 'API Error: Fable 5’s safeguards flagged this message.',
    })
    expect(copy.body).toContain('nothing is retrying')
    expect(copy.body).toContain('/model')
  })

  test('the paused turn outranks every other cause', () => {
    // A card explaining which option chat declined to press is beside the point
    // on a session whose turn is frozen on a billing question.
    expect(topAttention(['agent-blocked', 'session-paused', 'dialog-unmapped'])).toBe(
      'session-paused',
    )
  })

  test('a version mismatch quotes the version it saw and the ones it knows', () => {
    const copy = attentionCopy('registry-version-mismatch', {
      version: '2.2.0',
      verifiedVersions: ['2.1.227', '2.1.231'],
    })
    expect(copy.body).toContain('2.2.0')
    expect(copy.body).toContain('2.1.227 and 2.1.231')
  })

  test('an unreadable banner is a DIFFERENT admission from an unknown version', () => {
    // "We have not checked this version" and "we do not know which version this
    // is" are not the same fact, and the second is the more important one.
    const unknown = attentionCopy('registry-version-mismatch', { version: null }).body
    expect(unknown).toContain('could not read')
    expect(unknown).not.toContain('undefined')
    expect(unknown).not.toContain('null')
  })

  test('a known detail is folded in; a missing one costs a clause, not a hole', () => {
    const withDetail = attentionCopy('send-unconfirmed', { detail: 'HTTP 502' })
    expect(withDetail.body).toContain('HTTP 502')
    const without = attentionCopy('send-unconfirmed').body
    expect(without).not.toContain('undefined')
    expect(without).not.toMatch(/ {2}/)
  })

  test('one card, so the causes are RANKED — the lost message outranks the rest', () => {
    expect(topAttention(['transcript-stale', 'send-unconfirmed'])).toBe('send-unconfirmed')
    expect(topAttention(['transcript-stale', 'dialog-unmapped'])).toBe('dialog-unmapped')
    // Nullish raisers are ignored, so a caller can pass its hooks' fields in raw.
    expect(topAttention([null, undefined])).toBeNull()
    expect(topAttention([])).toBeNull()
  })
})

// ── 2. The evidence ─────────────────────────────────────────────────────────

describe('the ANSI mini-view', () => {
  test('a real capture keeps the terminal’s own colours', () => {
    const html = renderToStaticMarkup(
      <AttentionMiniView capture={read('composer-draft-ansi.txt')} />,
    )
    // `lib/ansi` emits inline styles per SGR run — colour is what makes this the
    // session's screen rather than a grey quote of it.
    expect(html).toContain('data-testid="chat-attention-mini"')
    expect(html).toContain('style="color:')
    // The capture's actual content, not just its escapes.
    expect(html).toContain('half a thought')
    // The escapes themselves must never reach the DOM.
    expect(html).not.toContain('[')
  })

  test('an empty capture renders NOTHING — message-only degrade', () => {
    expect(renderToStaticMarkup(<AttentionMiniView capture="" />)).toBe('')
    expect(renderToStaticMarkup(<AttentionMiniView />)).toBe('')
    // A capture of a stopped session is blank rows and colour resets, and that
    // is exactly the case that must not draw an empty black box.
    expect(renderToStaticMarkup(<AttentionMiniView capture={'\n  \n[39m\n'} />)).toBe('')
  })

  test('the bottom of the screen is what is kept, and the padding is dropped', () => {
    const capture = ['', 'one', 'two', 'three', '   ', ''].join('\n')
    expect(miniLines(capture)).toEqual(['one', 'two', 'three'])
    expect(miniLines(capture, 2)).toEqual(['two', 'three'])
    // Interior blank rows are the frame's own spacing and stay.
    expect(miniLines('a\n\nb')).toEqual(['a', '', 'b'])
  })

  test('a dialog capture is shown as a figure, not read out as prose', () => {
    const html = renderToStaticMarkup(<AttentionMiniView capture={read('perm-bash.txt')} />)
    expect(html).toContain('role="img"')
    expect(html).toContain('Do you want to proceed?')
  })
})

// ── 3. The card ─────────────────────────────────────────────────────────────

describe('the card', () => {
  test('every cause offers the terminal', () => {
    for (const cause of ATTENTION_ORDER) {
      const html = renderToStaticMarkup(
        <AttentionCard cause={cause} capture={read('perm-bash.txt')} onOpenTerminal={() => {}} />,
      )
      expect(html).toContain('data-testid="chat-attention-open-terminal"')
      expect(html).toContain(escapeHtml(attentionCopy(cause).title))
    }
  })

  test('the card is the copy plus the evidence, in that order', () => {
    const html = renderToStaticMarkup(
      <AttentionCard cause="dialog-unmapped" capture={read('perm-bash.txt')} />,
    )
    const title = html.indexOf(escapeHtml(attentionCopy('dialog-unmapped').title))
    const mini = html.indexOf('chat-attention-mini')
    expect(title).toBeGreaterThan(-1)
    expect(mini).toBeGreaterThan(title)
  })

  test('a card with no capture still states the fact', () => {
    const html = renderToStaticMarkup(<AttentionCard cause="send-unconfirmed" onOpenTerminal={() => {}} />)
    expect(html).not.toContain('chat-attention-mini')
    expect(html).toContain(escapeHtml(attentionCopy('send-unconfirmed').title))
    expect(html).toContain('data-testid="chat-attention-open-terminal"')
  })

  test('it does not claim a modality it cannot enforce', () => {
    // No portal, no focus trap: `aria-modal` here would tell a screen-reader
    // user the rest of the app is inert when it is not.
    const html = renderToStaticMarkup(<AttentionCard cause="waiting-unmodelled" />)
    expect(html).toContain('role="dialog"')
    expect(html).not.toContain('aria-modal')
  })

  test('the inline row is one line and one offer — no evidence, no actions', () => {
    const html = renderToStaticMarkup(
      <AttentionRow cause="send-unconfirmed" onExpand={() => {}} />,
    )
    expect(html).toContain(escapeHtml(attentionCopy('send-unconfirmed').title))
    expect(html).toContain('data-testid="chat-attention-show"')
    expect(html).toContain('aria-expanded="false"')
    // The body, the capture and the buttons belong to the expanded form: a
    // watchdog blip must not spend the whole live band.
    expect(html).not.toContain(escapeHtml(attentionCopy('send-unconfirmed').body))
    expect(html).not.toContain('chat-attention-mini')
    expect(html).not.toContain('chat-attention-open-terminal')
  })

  test('the scrim is a gesture, not a second control', () => {
    // The full-pane scrim closes the card on a tap, but it is `aria-hidden`:
    // named, it is announced beside the real ✕ as a second "Close" that no Tab
    // and no screen-reader button list can actually reach (measured in the
    // browser: tabIndex −1 on a 1220 px button). The keyboard's exits are the
    // ✕, Dismiss, and Escape.
    const html = renderToStaticMarkup(
      <AttentionOverlay open cause="send-unconfirmed" onClose={() => {}} />,
    )
    expect(html.match(/aria-label="Close"/g)?.length).toBe(1)
    expect(html).toContain('aria-hidden="true"')
  })

  test('the expanded card is a real modal, the inline row is not (A4 review)', () => {
    // It declared `role="dialog"` and then moved no focus and trapped nothing:
    // a keyboard user activating "Show terminal" kept focus on the row now
    // behind the scrim, and the next Tab walked into the composer and the
    // transcript's links — invisible, and still activatable. The overlay now
    // focuses the card, cycles Tab inside it and restores focus on close, which
    // is what earns `aria-modal`.
    const overlay = renderToStaticMarkup(
      <AttentionOverlay open cause="send-unconfirmed" onClose={() => {}} />,
    )
    expect(overlay).toContain('aria-modal="true"')
    expect(overlay).toContain('tabindex="-1"')
    // The SAME component inline claims neither: nothing traps focus there, and
    // claiming a modality the DOM does not enforce is the lie this fase refuses.
    const inline = renderToStaticMarkup(<AttentionCard cause="send-unconfirmed" />)
    expect(inline).not.toContain('aria-modal')
  })

  test('the overlay is nothing at all until it is opened', () => {
    expect(renderToStaticMarkup(<AttentionOverlay open={false} cause="send-unconfirmed" />)).toBe('')
    const html = renderToStaticMarkup(<AttentionOverlay open cause="send-unconfirmed" />)
    expect(html).toContain('data-testid="chat-attention-overlay"')
    expect(html).toContain('data-testid="chat-attention-card"')
  })
})

// ── 4. On the surface ───────────────────────────────────────────────────────

describe('the card on the chat surface', () => {
  const base = {
    name: NAME,
    session: SESSION,
    items: [],
    nowMs: 1_000,
    turnStart: null,
  } as const

  test('it enters INLINE — a row in the live band, not a modal in the face', () => {
    const html = renderToStaticMarkup(
      <ChatConversation {...base} attention="send-unconfirmed" onOpenTerminal={() => {}} />,
    )
    expect(html).toContain('data-testid="chat-attention-row"')
    expect(html).toContain('data-testid="chat-attention-show"')
    // The overlay is what the row OFFERS; it is not what it does.
    expect(html).not.toContain('data-testid="chat-attention-overlay"')
  })

  test('the inline row leads the live band — above even the permission card', () => {
    const html = renderToStaticMarkup(
      <ChatConversation {...base} attention="dialog-unmapped" />,
    )
    const band = html.indexOf('data-testid="chat-live-layer"')
    const row = html.indexOf('data-testid="chat-attention-row"')
    expect(band).toBeGreaterThan(-1)
    expect(row).toBeGreaterThan(band)
  })

  test('the row sits BELOW the echo it is about', () => {
    const pending: PendingSend[] = [
      { id: 'p1', text: 'ship it', atMs: 1, state: 'undelivered' },
    ]
    const html = renderToStaticMarkup(
      <ChatConversation {...base} pending={pending} attention="send-unconfirmed" />,
    )
    expect(html.indexOf('data-testid="chat-pending"')).toBeLessThan(
      html.indexOf('data-testid="chat-attention-row"'),
    )
  })

  test('expanded, the card is a layer over THIS pane — the surface root, not a portal', () => {
    const html = renderToStaticMarkup(
      <ChatConversation
        {...base}
        attention="registry-version-mismatch"
        attentionCtx={{ version: '2.2.0' }}
        attentionCapture={read('perm-bash.txt')}
        attentionExpanded
        onOpenTerminal={() => {}}
      />,
    )
    expect(html).toContain('data-testid="chat-attention-overlay"')
    expect(html).toContain('data-testid="chat-attention-mini"')
    expect(html).toContain('2.2.0')
    // Inside the surface's own root element, which is what makes the roster and
    // the other pane of a split stay live behind it.
    const root = html.indexOf('data-surface="chat"')
    expect(root).toBeGreaterThan(-1)
    expect(html.indexOf('data-testid="chat-attention-overlay"')).toBeGreaterThan(root)
  })

  test('with no cause the surface is exactly what A3 drew', () => {
    const html = renderToStaticMarkup(<ChatConversation {...base} />)
    expect(html).not.toContain('chat-attention')
  })
})

/** `renderToStaticMarkup` escapes the copy's curly apostrophes and ampersands;
 *  the assertions above compare against the same escaping rather than against a
 *  second, hand-maintained copy of every string. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Type-level: the causes the copy module knows and the ones the order lists are
// the same set — a cause added to the union without a sentence must not compile.
const _exhaustive: Record<AttentionCause, true> = {
  'send-unconfirmed': true,
  'dialog-unmapped': true,
  'registry-version-mismatch': true,
  'waiting-unmodelled': true,
  'transcript-stale': true,
}
void _exhaustive

/* ── the evidence must belong to the card it is printed in ────────────────── */

describe('detailFor', () => {
  const abort = 'the terminal’s selection sits on option 3 instead of 2'

  test('the winning cause gets its own evidence', () => {
    expect(detailFor('dialog-unmapped', 'dialog-unmapped', abort)).toBe(abort)
    expect(detailFor('registry-version-mismatch', 'registry-version-mismatch', abort)).toBe(abort)
  })

  test('a cause that did NOT win never lends its sentence to the one that did', () => {
    // The real collision: a mid-turn send times out (`send-unconfirmed`, which
    // outranks everything) while a dialog sequence has just aborted. Without
    // this, the send card would explain itself with the CARET's story.
    const top = topAttention(['send-unconfirmed', 'dialog-unmapped'])
    expect(top).toBe('send-unconfirmed')
    expect(detailFor(top, 'dialog-unmapped', abort)).toBeUndefined()
    expect(attentionCopy('send-unconfirmed', { detail: detailFor(top, 'dialog-unmapped', abort) }).body)
      .not.toContain('option 3')
  })

  test('nothing raised, nothing quoted', () => {
    expect(detailFor(null, 'dialog-unmapped', abort)).toBeUndefined()
    expect(detailFor('dialog-unmapped', null, abort)).toBeUndefined()
    expect(detailFor('dialog-unmapped', 'dialog-unmapped', null)).toBeUndefined()
    expect(detailFor('dialog-unmapped', 'dialog-unmapped', '')).toBeUndefined()
  })
})
