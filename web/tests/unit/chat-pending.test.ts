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
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import type { ChatEntry } from '../../src/components/chat/entries'
import {
  applyReceipt,
  CONFIRM_SKEW_MS,
  deliveryLine,
  isInlineOwned,
  latchUndelivered,
  markInlineOwned,
  normalizeSend,
  PROMPT_CLAMP_CHARS,
  reconcile,
  settleReceipted,
  settleUndelivered,
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

  // #13 — a queued send Claude Code promotes to a NON-`prompt` user kind still
  // reconciles, so the optimistic row leaves and does not stand beside the
  // confirmed bubble as a duplicate.
  test('a promoted `delegation` echo reconciles the optimistic row away', () => {
    const out = reconcile([mk('ship it', 1_000)], [entry('ship it', 1_500, 'delegation')], 2_000)
    expect(out).toEqual([])
  })

  test('a promoted `schedule` echo reconciles the optimistic row away', () => {
    const out = reconcile([mk('nightly deploy', 1_000)], [entry('nightly deploy', 1_500, 'schedule')], 2_000)
    expect(out).toEqual([])
  })

  test('a `teammate` entry with the same text never claims a pending', () => {
    // Still excluded: that turn was authored by ANOTHER agent, so matching it
    // would confirm a delivery of OUR send that never happened.
    const out = reconcile([mk('status?', 1_000)], [entry('status?', 1_500, 'teammate')], 2_000)
    expect(out).toHaveLength(1)
  })
})

describe('settleReceipted — the window-eviction exit (#45)', () => {
  /** A receipted, queued mid-turn row (delivered per the server, no transcript
   *  echo in the window yet). */
  function receiptedQueued(text: string, atMs: number): PendingSend {
    return { ...mk(text, atMs), receipted: true, activeAtSend: true }
  }

  test('a receipted row clears once idle AND an agent turn answered after the send', () => {
    // Delivered (receipted) and answered (an assistant entry after the send),
    // session back to idle — the echo need not be in the window. This is the
    // IMG_2441 stuck state clearing.
    const p = receiptedQueued('revert the migration', 10_000)
    const answered = [entry('done', 40_000, 'assistant')]
    expect(settleReceipted([p], answered, { active: false })).toEqual([])
  })

  test('it does NOT clear while the session is still active — the message is genuinely queued', () => {
    // The turn it is queued behind is still running and emitting agent entries
    // stamped after the send. Clearing here would pull the correct "queued
    // behind that turn" indicator out from under an unhandled message.
    const p = receiptedQueued('revert the migration', 10_000)
    const midTurn = [entry('still working', 20_000, 'tool_use')]
    const out = settleReceipted([p], midTurn, { active: true })
    expect(out).toHaveLength(1)
    // …and the live indicator still shows the queued sentence.
    expect(deliveryLine(out[0], { active: true })).toContain('queued behind that turn')
  })

  test('it does NOT clear when no agent turn has produced output after the send', () => {
    // Idle, receipted, but the only agent entry predates the send: no answer to
    // settle against.
    const p = receiptedQueued('revert the migration', 10_000)
    const before = [entry('old reply', 5_000, 'assistant')]
    expect(settleReceipted([p], before, { active: false })).toHaveLength(1)
  })

  test('it never clears an UNRECEIPTED row, however quiet the session', () => {
    // No server receipt = no proof of delivery, so an idle session with agent
    // output is not evidence THIS send landed. The watchdog still owns it.
    const p = mk('revert the migration', 10_000)
    const answered = [entry('done', 40_000, 'assistant')]
    expect(settleReceipted([p], answered, { active: false })).toEqual([p])
  })

  test('same reference back when nothing settled', () => {
    const cur = [receiptedQueued('x', 10_000)]
    expect(settleReceipted(cur, [], { active: false })).toBe(cur)
  })

  test('a live in-flight send in the same list is never dropped', () => {
    // A `sending` row (POST not back) is not receipted, so settle leaves it —
    // only the answered receipted row goes.
    const inflight = mk('typing', 41_000, 'sending')
    const done = receiptedQueued('revert', 10_000)
    const out = settleReceipted([done, inflight], [entry('ok', 40_000, 'assistant')], { active: false })
    expect(out).toEqual([inflight])
  })
})

describe('settleUndelivered — the lost-response eviction exit (IMG_2451)', () => {
  /** A LOST-RESPONSE row: the POST left but no reply came back (status-0
   *  transport failure), sent into an IDLE session, escalated to undelivered
   *  with the "Can't reach supermux-server" line. `seen` carries the pre-send
   *  window; the echo that would clear it has been evicted from a long turn. */
  function lostResponse(text: string, atMs: number, over: Partial<PendingSend> = {}): PendingSend {
    return {
      ...mk(text, atMs, 'undelivered'),
      transportError: true,
      activeAtSend: false,
      seen: new Set(['old']),
      note: 'Can’t reach supermux-server.',
      ...over,
    }
  }
  /** The aliveness ledger: the session was last observed active at `at`. */
  const aliveAt = (at: number) => (ms: number) => at >= ms

  test('clears once idle + answered + the session went active after the send, echo evicted', () => {
    // Delivered and ANSWERED — the assistant reply is in the window — but this
    // send's own prompt echo was evicted before reconcile could match it. The
    // aliveness ledger witnessed the turn this send started. The false failure
    // and its duplicating Retry go away with no transcript echo to match.
    const p = lostResponse('deploy now', 10_000)
    const answered = [entry('done', 40_000, 'assistant')]
    const out = settleUndelivered([p], answered, { active: false, sawActiveSince: aliveAt(30_000) })
    expect(out).toEqual([])
  })

  test('a GENUINELY-LOST send into an idle session STILL shows the error', () => {
    // POST failed, nothing was typed, so the idle session produced no turn: no
    // agent output after the send AND the ledger never saw it go active. The row
    // keeps "Can't reach supermux-server. Retry".
    const p = lostResponse('deploy now', 10_000)
    // No agent entry after the send at all.
    expect(settleUndelivered([p], [], { active: false, sawActiveSince: aliveAt(0) })).toEqual([p])
    // An agent turn exists but the ledger never saw the session go active AFTER
    // this send (the answer predates it / belongs to an older turn).
    const stale = [entry('old reply', 5_000, 'assistant')]
    expect(settleUndelivered([p], stale, { active: false, sawActiveSince: aliveAt(0) })).toEqual([p])
  })

  test('does NOT clear while a turn is still running', () => {
    const p = lostResponse('deploy now', 10_000)
    const midTurn = [entry('working', 20_000, 'tool_use')]
    expect(
      settleUndelivered([p], midTurn, { active: true, sawActiveSince: aliveAt(30_000) }),
    ).toEqual([p])
  })

  test('never clears a send made MID-TURN — the running turn’s output proves nothing', () => {
    // `activeAtSend` true: a previous turn was already running, so agent output
    // after the send is that turn’s, not evidence THIS send landed. Only the
    // receipt or the echo may clear such a row.
    const p = lostResponse('deploy now', 10_000, { activeAtSend: true })
    const answered = [entry('done', 40_000, 'assistant')]
    expect(
      settleUndelivered([p], answered, { active: false, sawActiveSince: aliveAt(30_000) }),
    ).toEqual([p])
  })

  test('never clears a server REFUSAL (409) — the server said no', () => {
    // A hard refusal is not a transport error, so later agent output cannot
    // confirm a delivery the server itself declined.
    const p = lostResponse('deploy now', 10_000, { transportError: false })
    const answered = [entry('done', 40_000, 'assistant')]
    expect(
      settleUndelivered([p], answered, { active: false, sawActiveSince: aliveAt(30_000) }),
    ).toEqual([p])
  })

  test('defers to reconcile whenever a user echo is visible after the send', () => {
    // This send’s OWN echo is in the window — reconcile owns that case, so the
    // eviction exit keeps its hands off (and reconcile then clears it).
    const p = lostResponse('deploy now', 10_000)
    const withEcho = [entry('deploy now', 12_000, 'prompt'), entry('done', 40_000, 'assistant')]
    expect(
      settleUndelivered([p], withEcho, { active: false, sawActiveSince: aliveAt(30_000) }),
    ).toEqual([p])
    // …and reconcile does clear it, leaving the transcript copy as sole survivor.
    expect(reconcile([p], withEcho, 60_000)).toEqual([])
  })

  test('a LATER send’s turn is never mistaken for this one’s', () => {
    // The lost send X (idle), then a SUCCESSFUL send Y whose echo is in the
    // window. The visible answer may be Y’s, so X must NOT be cleared here — its
    // own delivery is still unproven. `hasUserEntryAfter` sees Y’s echo and
    // defers. (Y’s own row is cleared by reconcile elsewhere.)
    const x = lostResponse('first', 10_000)
    const entries = [entry('second', 30_000, 'prompt'), entry('answer', 40_000, 'assistant')]
    expect(
      settleUndelivered([x], entries, { active: false, sawActiveSince: aliveAt(35_000) }),
    ).toEqual([x])
  })

  test('same reference back when nothing settled', () => {
    const cur = [lostResponse('x', 10_000, { transportError: false })]
    expect(settleUndelivered(cur, [entry('a', 40_000, 'assistant')], {
      active: false,
      sawActiveSince: () => true,
    })).toBe(cur)
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

// ── The review findings (A4 review) ─────────────────────────────────────────

describe('reconcile — the clock is not evidence', () => {
  /** A send that knows what was already on screen when it left. */
  function sent(text: string, atMs: number, seen: string[]): PendingSend {
    return { ...mk(text, atMs), seen: new Set(seen) }
  }

  test('a browser clock running FAST does not fake a failure', () => {
    // `serverNowMs()` is `Date.now()` until an `activity_at` has ever been seen
    // (`latency.ts`, one feeder), so `atMs` is a BROWSER stamp while the entries
    // it was compared against are SERVER-stamped. 30s of skew and the echo
    // landing one server-second later reads as "older than the send": the
    // surface then states "that message didn't reach the session" over a bubble
    // visible in the transcript directly above it.
    const p = sent('hello', 1_030_000 /* clock 30s fast */, ['old-1'])
    const echo = entry('hello', 1_000_500, 'prompt', 'new-1')
    expect(reconcile([p], [echo], 1_031_000)).toEqual([])
  })

  test('a browser clock running SLOW does not fake a delivery', () => {
    // The quiet one. A clock 30s behind let a PREVIOUS identical prompt claim
    // the send, so a message that never arrived was reconciled away silently.
    const older = entry('continue', 1_000_000, 'prompt', 'old-continue')
    const p = sent('continue', 970_000 /* clock 30s slow */, ['old-continue'])
    expect(reconcile([p], [older], 971_000).map((x) => x.text)).toEqual(['continue'])
  })

  test('the stamp rule still applies when the transcript had not loaded', () => {
    // No snapshot = nothing is known about what was on screen. There is also,
    // by construction, no older entry for the send to be confused with.
    const p = mk('hello', 10_000)
    expect(reconcile([p], [entry('hello', 10_002)], 11_000)).toEqual([])
    // Older than the send by more than the truncation tolerance: not its echo.
    expect(reconcile([p], [entry('hello', 500)], 11_000)).toEqual([p])
  })
})

describe('the server’s delivery receipt', () => {
  const receipt = (text: string, atS: number) => ({ text, atS })

  test('a receipt newer than the send confirms it — whatever the transport did', () => {
    // `set_last_send` is written by `POST /send` AFTER the paste and the Enter.
    // A response that never came back is not evidence of non-delivery, and this
    // is the only evidence that can tell the two apart.
    const p: PendingSend = { ...mk('deploy', 1_000, 'undelivered'), receiptAtS: 40 }
    const [out] = applyReceipt([p], receipt('deploy', 41))
    expect(out.receipted).toBe(true)
    // The escalation is TAKEN BACK: leaving it up leaves a Retry button over a
    // message that landed, and pressing it sends the instruction twice.
    expect(out.state).toBe('unconfirmed')
  })

  test('the PREVIOUS send’s receipt confirms nothing', () => {
    const p: PendingSend = { ...mk('deploy', 1_000), receiptAtS: 41 }
    expect(applyReceipt([p], receipt('deploy', 41))).toEqual([p])
  })

  test('a receipt for different text confirms nothing', () => {
    const p: PendingSend = { ...mk('deploy', 1_000), receiptAtS: 40 }
    expect(applyReceipt([p], receipt('revert', 41))).toEqual([p])
  })

  test('a burst back-fills: the last member is text-matched, the earlier ones ride its receipt', () => {
    // The scalar receipt only ever holds the LAST send's text, so only msg3 is
    // text-matched. msg1/msg2 were POSTed (unconfirmed) and serialized ahead of
    // it, so they were delivered too — they must not later show the false
    // "didn't reach the session".
    const msg1: PendingSend = { ...mk('one', 1_000), receiptAtS: 40 }
    const msg2: PendingSend = { ...mk('two', 1_500), receiptAtS: 40 }
    const msg3: PendingSend = { ...mk('three', 2_000), receiptAtS: 40 }
    const out = applyReceipt([msg1, msg2, msg3], receipt('three', 42))
    expect(out.map((p) => p.receipted)).toEqual([true, true, true])
    // …and being receipted, none of them escalates.
    for (const p of out) {
      expect(watchdogState(p, { nowMs: WATCHDOG_MS * 10, sawActiveSince: () => false })).toBe(
        'unconfirmed',
      )
    }
  })

  test('back-fill never confirms a NEWER un-matched send, nor a refused earlier one', () => {
    // Newer than the matched send → serialized AFTER it, so its own receipt is
    // still owed; must stay unreceipted.
    const matched: PendingSend = { ...mk('matched', 1_000), receiptAtS: 40 }
    const newer: PendingSend = { ...mk('newer', 2_000), receiptAtS: 40 }
    // An earlier UNDELIVERED send may be a genuinely refused one (409, no
    // last_send written) — atS ordering alone must not confirm it.
    const refused: PendingSend = { ...mk('refused', 500, 'undelivered'), receiptAtS: 40 }
    const out = applyReceipt([refused, matched, newer], receipt('matched', 41))
    const byId = Object.fromEntries(out.map((p) => [p.text, p]))
    expect(byId.matched.receipted).toBe(true)
    expect(byId.newer.receipted).toBeUndefined()
    expect(byId.refused.receipted).toBeUndefined()
    expect(byId.refused.state).toBe('undelivered')
  })

  test('a receipted send never escalates', () => {
    // It is IN the session. The only open question is when the transcript will
    // echo it — a queued prompt can sit there for minutes — and "didn't reach
    // the session" would be a false statement with a duplicating button on it.
    const p: PendingSend = { ...mk('deploy', 0), receipted: true }
    expect(watchdogState(p, { nowMs: WATCHDOG_MS * 10, sawActiveSince: () => false })).toBe(
      'unconfirmed',
    )
  })

  test('an unreceipted send in the same shape still escalates', () => {
    const p = mk('deploy', 0)
    expect(watchdogState(p, { nowMs: WATCHDOG_MS * 10, sawActiveSince: () => false })).toBe(
      'undelivered',
    )
  })
})

/**
 * ONE OWNER PER FAILED SEND.
 *
 * A refused send used to be stated three times at once — the inline row under
 * the failed bubble, the attention card, and the composer's banner repeating
 * the same sentence with its own Dismiss. At 1440x900 that is ~330px, roughly
 * 40% of the reading column, and on a phone the reason string appeared in
 * `body.innerText` twice. The row wins: it is anchored to the thing that
 * failed and it already carries Retry.
 *
 * The marker is pure and asserted directly; the two suppressions it drives live
 * in hooks, so they are asserted against the source — the same way
 * `session-schedules.test.tsx` pins its dependency rule.
 */
describe('one owner per failed send', () => {
  test('an error the inline row has stated is recognised; anything else is not', () => {
    const err = new Error('the session refused this')
    expect(isInlineOwned(err)).toBe(false)
    expect(markInlineOwned(err)).toBe(err)
    expect(isInlineOwned(err)).toBe(true)
    // A different error carrying the SAME message is not the same failure.
    expect(isInlineOwned(new Error('the session refused this'))).toBe(false)
    expect(isInlineOwned(undefined)).toBe(false)
    expect(isInlineOwned('nope')).toBe(false)
  })

  test('a non-object rejection is wrapped, keeps its message, and stays marked', () => {
    const wrapped = markInlineOwned('boom')
    expect(isInlineOwned(wrapped)).toBe(true)
    expect((wrapped as Error).message).toBe('boom')
  })

  test('the tracked submit marks what it rethrows', () => {
    const src = readFileSync(
      new URL('../../src/components/chat/use-pending-sends.ts', import.meta.url),
      'utf8',
    )
    expect(src).toContain('throw markInlineOwned(err)')
    // …and it no longer raises the card for a send that has a bubble.
    expect(src).not.toContain("? 'send-unconfirmed' : null")
    expect(src).toContain('attention: null as PendingAttention | null')
  })

  test('the composer banner stays quiet for a failure that already has a row', () => {
    const src = readFileSync(
      new URL('../../src/components/chat/use-composer.ts', import.meta.url),
      'utf8',
    )
    // The send-failed banner is raised only under the guard.
    const guard = src.indexOf('if (!isInlineOwned(err)) {')
    const banner = src.indexOf("kind: 'send-failed'")
    expect(guard).toBeGreaterThan(-1)
    expect(banner).toBeGreaterThan(guard)
  })
})
