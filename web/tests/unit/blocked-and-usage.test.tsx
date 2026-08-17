/**
 * The blocked condition and the usage gauge, on the surfaces that draw them.
 *
 * These two facts arrive on their own fields (`session.blocked`,
 * `session.rate_limits`) for a reason the audit made expensive: the session's
 * STATUS cannot carry either. A limit-hit turn ends with an ordinary `Stop`, so
 * `status` is `idle`; a startup wedge never starts a turn at all, so `status`
 * settles on `idle` too. Every assertion below is one half of "a session that
 * cannot work must not render as one that can".
 */

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { attentionCopy, topAttention } from '../../src/components/chat/attention'
import SessionHeaderPill from '../../src/components/chat/header-pill'
import {
  USAGE_FLOOR_PCT,
  USAGE_HOT_PCT,
  usageTitle,
  worstWindow,
} from '../../src/lib/rate-limits'
import { attentionFor, tierFor } from '../../src/lib/attention-tiers'
import type { AttentionSession } from '../../src/lib/attention-tiers'
import type { TileSession } from '../../src/components/session-tile/types'

const BASE: AttentionSession = {
  name: 'vx-chat',
  status: 'idle',
  updated_at: '2026-08-17T10:00:00Z',
  archived: false,
} as AttentionSession

const LIMIT = {
  kind: 'limit',
  text: "You've hit your weekly limit · resets Aug 17, 4am (Europe/Amsterdam)",
  detail: '/upgrade or /usage-credits to finish what you’re working on.',
}

describe('the roster tier — a blocked session wants a human', () => {
  test('an idle-but-blocked session is `needs`, not `quiet`', () => {
    // THE FINDING, executable. `status` is genuinely `idle` here — the turn
    // ended normally — and before `blocked` existed this row was pixel-identical
    // to a healthy one while the account was cut off for five hours.
    expect(tierFor(BASE)).toBe('quiet')
    expect(tierFor({ ...BASE, blocked: LIMIT } as AttentionSession)).toBe('needs')
  })

  test('a startup wedge is `needs` too — it is the only signal that exists', () => {
    // No transcript, no hook, no non-idle status: a session parked on the trust
    // gate has nothing else that could ever light this row up.
    const wedged = {
      ...BASE,
      status: 'waiting',
      blocked: { kind: 'startup', wedge: 'trust', text: 'Accessing workspace:' },
    } as AttentionSession
    expect(attentionFor(wedged).tier).toBe('needs')
    expect(attentionFor(wedged).dotKind).toBe('needs')
  })

  test('a limit WARNING does not promote the row', () => {
    // The session still works. A tier that fires at 70 % utilisation would be a
    // roster full of red dots about nothing, which is the failure mode this
    // model exists to avoid.
    const warned = { ...BASE, limit_warning: "You've used 77% of your limit" } as AttentionSession
    expect(tierFor(warned)).toBe('quiet')
  })
})

describe('the usage gauge — quiet until it matters', () => {
  test('says nothing below the floor', () => {
    expect(worstWindow({ five_hour: { used_pct: USAGE_FLOOR_PCT - 1 } })).toBeNull()
    expect(worstWindow({})).toBeNull()
    expect(worstWindow(undefined)).toBeNull()
  })

  test('the WORSE window wins the single chip', () => {
    const r = { five_hour: { used_pct: 62 }, seven_day: { used_pct: 91 } }
    expect(worstWindow(r)).toEqual({ label: '7d', pct: 91, hot: true })
    // …and the quiet one is still reachable, on the hover.
    expect(usageTitle(r)).toBe('5-hour window 62% used · 7-day window 91% used')
  })

  test('`hot` is the threshold the chip changes colour on, not a rounding', () => {
    expect(worstWindow({ five_hour: { used_pct: USAGE_HOT_PCT } })?.hot).toBe(true)
    expect(worstWindow({ five_hour: { used_pct: USAGE_HOT_PCT - 0.1 } })?.hot).toBe(false)
  })

  test('a bucket with no percentage is not a bucket', () => {
    // Claude Code omits `rate_limits` on a fresh boot and can omit either
    // window; a NaN must never reach the chip as `NaN%`.
    expect(worstWindow({ five_hour: { used_pct: Number.NaN } })).toBeNull()
  })
})

describe('the chat header says the condition beside the status', () => {
  const render = (session: Partial<TileSession>) =>
    renderToStaticMarkup(
      <SessionHeaderPill
        name="vx-chat"
        session={{ name: 'vx-chat', status: 'idle', dir: '/tmp', provider: 'claude', preview_lines: [], updated_at: '', ...session } as TileSession}
      />,
    )

  test('a blocked session gets the chip, and the terminal’s own sentence on hover', () => {
    const html = render({ blocked: LIMIT })
    expect(html).toContain('Limit reached')
    expect(html).toContain('resets Aug 17, 4am')
    // The status dot is NOT replaced: `idle` is the truth about the turn, the
    // chip is the truth about the session, and both are true at once.
    expect(html).toContain('chat-header-blocked')
  })

  test('a warning is a quieter chip, and never both', () => {
    const warned = render({ limit_warning: "You've used 77% of your Fable 5 limit" })
    expect(warned).toContain('Nearing limit')
    expect(warned).not.toContain('chat-header-blocked')
    // A blocked session does not also show the warning — the block supersedes.
    const both = render({ blocked: LIMIT, limit_warning: "You've used 99%" })
    expect(both).not.toContain('Nearing limit')
  })

  test('a healthy session’s header is unchanged — no chip, no gauge', () => {
    const html = render({ rate_limits: { five_hour: { used_pct: 12 } } })
    expect(html).not.toContain('chat-header-blocked')
    expect(html).not.toContain('chat-header-limit-warning')
    expect(html).not.toContain('5h')
  })
})

describe('the attention card ranks the condition above the dialog causes', () => {
  test('a blocked session outranks a dialog chat will not answer', () => {
    // A card explaining which option chat declined to press is beside the point
    // on a session that could not act on the answer anyway.
    expect(topAttention(['dialog-unmapped', 'session-blocked'])).toBe('session-blocked')
    // …but not above a message that never arrived, which is the one cause where
    // something the USER authored is missing.
    expect(topAttention(['session-blocked', 'send-unconfirmed'])).toBe('send-unconfirmed')
  })

  test('the copy quotes the banner and never says "something went wrong"', () => {
    const copy = attentionCopy('session-blocked', { detail: LIMIT.text })
    expect(copy.body).toContain('resets Aug 17, 4am')
    expect(copy.title).not.toMatch(/oops|sorry|went wrong/i)
    // It names the one thing that unblocks a session before its reset.
    expect(copy.body).toMatch(/different model/i)
  })
})
