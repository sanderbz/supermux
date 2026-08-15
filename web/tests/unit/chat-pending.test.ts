/**
 * P10 — the optimistic echo, and the watchdog that makes it honest (fase A4 T4).
 * ─────────────────────────────────────────────────────────────────────────────
 * An optimistic echo is a promise the UI makes on the network's behalf. This is
 * the module that keeps it: every echo either RECONCILES against the transcript
 * (the send landed, the bubble above is the real thing) or ESCALATES (nothing
 * confirmed it, say so and offer the terminal). There is no third outcome, and
 * in particular there is no "assume it worked".
 *
 * Everything asserted here is pure — which is the whole point of the split. The
 * store, the timer and the pixels are in `use-pending-sends.ts` /
 * `conversation.tsx`; the two decisions that can silently lie to a user (did
 * this message land? has it been long enough to say it didn't?) are here, where
 * `bun test` can hold them to account without a DOM, a clock or a server.
 */
import { describe, expect, test } from 'bun:test'

import type { ChatEntry } from '../../src/components/chat/entries'
import {
  CONFIRM_SKEW_MS,
  latchUndelivered,
  normalizeSend,
  PROMPT_CLAMP_CHARS,
  reconcile,
  watchdogState,
  WATCHDOG_MS,
  type PendingSend,
} from '../../src/components/chat/pending'

/** A pending send, in the SERVER-clock ms the store stamps it with. */
function mk(text: string, atMs: number, state: PendingSend['state'] = 'unconfirmed'): PendingSend {
  return { id: `p-${atMs}-${text}`, text, atMs, state }
}

/**
 * A wire entry. The `ms` argument is the one place this file converts: the wire
 * stamps `ts` in SECONDS (`recall.rs` `parse_ts`, and `use-chat-turn` multiplies
 * by 1000 everywhere it compares), so a millisecond in a test is `ms / 1000`
 * here and `reconcile` does the multiplication back.
 */
function entry(text: string, ms: number, kind = 'prompt', uuid = `u-${ms}-${text}`): ChatEntry {
  return { uuid, ts: ms / 1000, text, kind }
}

describe('normalizeSend', () => {
  test('trims the ends and collapses CRLF — and does nothing else', () => {
    expect(normalizeSend('  ship it\r\nnow  ')).toBe('ship it\nnow')
    // Inner spacing and case are LOAD-BEARING: the transcript echoes the prompt
    // verbatim (a0 §5), so an aggressive normaliser would let one pending claim
    // another's entry in a session that sends near-identical text twice.
    expect(normalizeSend('ship  IT')).toBe('ship  IT')
  })
})

describe('reconcile', () => {
  test('a matching user entry reconciles the echo away', () => {
    expect(reconcile([mk('hello', 1_000)], [entry('hello', 1_002)], 2_000)).toEqual([])
  })

  test('the same text twice claims one entry each, oldest first', () => {
    const out = reconcile(
      [mk('ping', 1_000), mk('ping', 1_100)],
      [entry('ping', 1_050)],
      2_000,
    )
    expect(out.map((x) => x.atMs)).toEqual([1_100])
  })

  test('an entry older than the send never claims it', () => {
    // The user typed the same word in the terminal a minute ago; that echo
    // belongs to that turn, not to this send.
    const out = reconcile([mk('ok', 100_000)], [entry('ok', 40_000)], 101_000)
    expect(out).toHaveLength(1)
  })

  test('the wire’s whole-second truncation still reconciles', () => {
    // `ts` is floored to a second, so a confirmed entry can be stamped up to
    // 999ms BEFORE the send that produced it. That is what the skew is for.
    const out = reconcile([mk('go', 10_900)], [entry('go', 10_000)], 12_000)
    expect(out).toEqual([])
    expect(CONFIRM_SKEW_MS).toBeGreaterThanOrEqual(1_000)
  })

  test('an assistant entry with the same text never claims a pending', () => {
    // Claude quoting the prompt back is not Claude having received it.
    const out = reconcile([mk('run the tests', 1_000)], [entry('run the tests', 1_500, 'assistant')], 2_000)
    expect(out).toHaveLength(1)
  })

  test('a slash command lands as kind `command` and still reconciles', () => {
    const out = reconcile([mk('/compact', 1_000)], [entry('/compact', 1_500, 'command')], 2_000)
    expect(out).toEqual([])
  })

  test('the wire’s 8000-char clamp does not strand a long send', () => {
    const long = 'x'.repeat(PROMPT_CLAMP_CHARS + 250)
    const clamped = long.slice(0, PROMPT_CLAMP_CHARS)
    expect(reconcile([mk(long, 1_000)], [entry(clamped, 1_200)], 2_000)).toEqual([])
  })

  test('an entry stamped far in the future never claims a pending', () => {
    const out = reconcile([mk('hello', 1_000)], [entry('hello', 3_600_000)], 2_000)
    expect(out).toHaveLength(1)
  })

  test('survivors come back oldest-first, whatever order they went in', () => {
    const out = reconcile([mk('b', 2_000), mk('a', 1_000)], [], 3_000)
    expect(out.map((p) => p.text)).toEqual(['a', 'b'])
  })

  test('a send already declared FAILED never claims the resend’s confirmation', () => {
    // The user's own recovery path: the POST was rejected, so the words are
    // still in the composer AND an undelivered row is on screen — and a second
    // Enter is the likelier retry of the two. Only the second send is really in
    // the pty, so the entry is the second one's.
    //
    // Under plain FIFO the dead echo eats it: the failure notice vanishes, the
    // message that DID land is accused of never arriving, and its Retry sends a
    // third copy into the agent. It never heals, because no second entry is
    // coming for a POST that was refused.
    const failed = mk('ship it', 1_000, 'undelivered')
    const resent = mk('ship it', 4_000, 'unconfirmed')
    const out = reconcile([failed, resent], [entry('ship it', 5_000)], 6_000)
    expect(out.map((p) => p.state)).toEqual(['undelivered'])
    expect(out[0].atMs).toBe(1_000)
  })

  test('…but a failed send still reconciles when it is the only candidate', () => {
    // The escalation is a verdict on the evidence available, not a life
    // sentence: an entry that turns up later is better evidence, and the row
    // goes away instead of accusing a delivery that happened.
    const out = reconcile([mk('ship it', 1_000, 'undelivered')], [entry('ship it', 9_000)], 10_000)
    expect(out).toEqual([])
  })
})

describe('the delivery watchdog', () => {
  const dead = { nowMs: WATCHDOG_MS + 1, sawActiveSince: () => false }

  test('no entry + no Active transition in 5s → undelivered', () => {
    expect(watchdogState(mk('x', 0), dead)).toBe('undelivered')
  })

  test('an Active transition within 5s holds it at unconfirmed even with no entry', () => {
    expect(
      watchdogState(mk('x', 0), { nowMs: WATCHDOG_MS + 1, sawActiveSince: () => true }),
    ).toBe('unconfirmed')
  })

  test('inside the window it is simply unconfirmed', () => {
    expect(watchdogState(mk('x', 0), { nowMs: WATCHDOG_MS - 1, sawActiveSince: () => false })).toBe(
      'unconfirmed',
    )
  })

  test('status is irrelevant to the escalation — waiting, idle and active all escalate', () => {
    // The signature carries no status ON PURPOSE (master plan §4.4.1): a session
    // that is "active" because a PREVIOUS turn is still running says nothing
    // about whether THIS send arrived. Only evidence stamped after the send
    // counts, and that is what `sawActiveSince` reports.
    for (const _status of ['waiting', 'idle', 'active']) {
      expect(watchdogState(mk('x', 0), dead)).toBe('undelivered')
    }
  })

  test('the probe asks for evidence after the send AND inside the window', () => {
    const asked: number[] = []
    const probe = (ms: number) => {
      asked.push(ms)
      return false
    }
    // A young send: the send's own stamp is the later bound.
    watchdogState(mk('x', 4_200), { nowMs: 4_200 + WATCHDOG_MS, sawActiveSince: probe })
    expect(asked).toEqual([4_200])
    // An old one: only the last WATCHDOG_MS of aliveness still counts.
    asked.length = 0
    watchdogState(mk('x', 0), { nowMs: 100_000, sawActiveSince: probe })
    expect(asked).toEqual([100_000 - WATCHDOG_MS])
  })

  test('a running turn rolls the deadline forward — a queued send does not cry wolf', () => {
    // The ledger: the session was last observed active at 30s. A send made at
    // 10s (mid-turn, so Claude queued it and no entry exists yet) is still
    // deferred at 31s, because the turn is demonstrably alive.
    const alive = (at: number) => (ms: number) => at >= ms
    expect(watchdogState(mk('queued', 10_000), { nowMs: 31_000, sawActiveSince: alive(30_000) })).toBe(
      'unconfirmed',
    )
  })

  test('aliveness DEFERS the verdict, it never cancels it', () => {
    // Same send, but the turn ended at 30s and nothing has confirmed it since.
    const alive = (at: number) => (ms: number) => at >= ms
    expect(watchdogState(mk('queued', 10_000), { nowMs: 36_000, sawActiveSince: alive(30_000) })).toBe(
      'undelivered',
    )
  })

  test('a POST still in flight never escalates', () => {
    // `sending` means the request has not come back yet. Escalating it would
    // offer a Retry that double-sends the message the server is at that moment
    // typing into the pty.
    expect(watchdogState(mk('x', 0, 'sending'), dead)).toBe('sending')
  })

  test('once undelivered it stays undelivered until the user acts', () => {
    expect(
      watchdogState(mk('x', 0, 'undelivered'), { nowMs: 1, sawActiveSince: () => true }),
    ).toBe('undelivered')
  })

  test('the escalation is LATCHED, so "stays said" is true of the store too', () => {
    // The guard above can only speak for the state it is handed. The store has
    // to be told, or the next second in which the session reads active again —
    // the user going to look at the pty and typing there is enough — silently
    // un-escalates a failure the surface already stated, and Retry appears and
    // disappears under the cursor.
    const cur = [mk('x', 0), mk('y', 0)]
    const next = latchUndelivered(cur, new Set([cur[0].id]))
    expect(next.map((p) => p.state)).toEqual(['undelivered', 'unconfirmed'])
    // And it re-escalates as unconfirmed once, not on every tick: same
    // reference back when nothing moved, because the caller runs this off its
    // own output.
    expect(latchUndelivered(next, new Set([cur[0].id]))).toBe(next)
    expect(latchUndelivered(cur, new Set())).toBe(cur)
  })

  test('a POST in flight is never latched out from under itself', () => {
    // `sending` is not the watchdog's to escalate (it would offer a Retry that
    // double-sends what the server is at that moment typing), so it is not the
    // latch's either.
    const cur = [mk('x', 0, 'sending')]
    expect(latchUndelivered(cur, new Set([cur[0].id]))).toBe(cur)
  })
})
