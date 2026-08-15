// P10 — the optimistic echo, as arithmetic (fase A4 T4).
//
// THE MECHANISM master plan §4.4 calls INVERTED DETECTION: nothing on this
// surface is assumed to have worked. A send is drawn the moment it leaves, and
// from then on it must either RECONCILE — a matching user turn appears in the
// confirmed transcript, so the echo has become real and disappears — or
// ESCALATE — nothing confirmed it inside the watchdog window and no evidence of
// life arrived either, so the surface says "this did not land" and offers the
// terminal. There is deliberately no third outcome: "probably fine" is how a
// chat client silently swallows a message.
//
// Pure and dependency-free (structural `ChatEntry` only), for the same reason
// `entries.ts` is: the two decisions that can lie to a user are testable in
// `bun test` with no DOM, no clock and no server. The store, the timer and the
// pixels live in `use-pending-sends.ts` and `conversation.tsx`.
//
// CLOCK DOMAIN, once, for the whole file: every `*Ms` argument is SERVER-clock
// milliseconds (`latency.ts serverNowMs`), because the timestamps they are
// compared against are server-stamped. Wire entries carry `ts` in SECONDS
// (`recall.rs parse_ts`); the conversion happens here, exactly once.

import type { ChatEntry } from './entries'

export type PendingState = 'sending' | 'unconfirmed' | 'undelivered'

export interface PendingSend {
  /** Client-side identity. Never a server id — the server has none for a send
   *  that may not have arrived. */
  id: string
  /** What was sent, verbatim. This is also what is drawn in the bubble. */
  text: string
  /** SERVER-clock ms at which the POST left this client. A retry re-stamps it:
   *  a new delivery gets a new watchdog window. */
  atMs: number
  state: PendingState
  /** Display-only: why the last attempt failed or was refused. Neither function
   *  below reads it — it exists so the row can say something more useful than
   *  "undelivered" when the reason is known (a rejected POST, a refused retry). */
  note?: string
  /**
   * The uuids of the confirmed entries that were ALREADY on screen when this
   * send left — the clock-free half of reconciliation (A4 review).
   *
   * `reconcile` used to ask "is this entry stamped at or after the send?", which
   * compares a BROWSER-clock stamp (`serverNowMs()` falls back to `Date.now()`
   * until an `activity_at` has ever been seen) against SERVER-stamped entries.
   * A browser 30s fast made every echo look too old — the surface then states a
   * failure over a message visible in the transcript directly above it; a
   * browser 30s slow let a PREVIOUS identical prompt claim the send, which is
   * the same lie in the other direction and much quieter.
   *
   * An entry the user was already looking at when they pressed Enter cannot be
   * the echo of that Enter. No clock is involved in saying so.
   *
   * `null`/absent = the transcript had not loaded yet, so nothing is known about
   * what was on screen and the stamp comparison is the fallback.
   */
  seen?: ReadonlySet<string> | null
  /** The session's `last_send_at` (server epoch SECONDS) as it read when this
   *  send left — the baseline the delivery receipt is compared against. */
  receiptAtS?: number
  /** The SERVER confirmed it typed this text into the pty (`set_last_send`,
   *  written by `/send` after the paste + Enter). Transport-independent, so it
   *  survives exactly the failure the watchdog cannot see through. */
  receipted?: boolean
}

/**
 * How far BEFORE a send an entry may be stamped and still be its confirmation.
 *
 * The wire floors `ts` to a whole second, so the transcript echo of a send made
 * at 10.9s is stamped 10s — 900ms "before" the send that caused it. 2s covers
 * that truncation with room for the client↔server skew estimate, and stays far
 * under the interval at which a human sends the same words twice.
 */
export const CONFIRM_SKEW_MS = 2_000

/**
 * The recall wire clamps prompt text to this (`PROMPT_MAX_CHARS`,
 * `recall.rs:36`), by plain truncation and with no ellipsis. Without the prefix
 * rule below, every send longer than this would echo forever beside its own
 * confirmed bubble.
 */
export const PROMPT_CLAMP_CHARS = 8_000

/**
 * An entry stamped further than this into the future is not treated as anybody's
 * confirmation. The tolerance is deliberately huge: a wrong skew estimate must
 * never be able to break reconciliation (that would duplicate every message),
 * while a clock that has jumped by hours still cannot retro-claim a send.
 */
export const FUTURE_TOLERANCE_MS = 60_000

/**
 * The chat view's user-authored kinds (`recall.rs read_chat_turns` keeps
 * `Prompt | Command | Teammate`). `teammate` is excluded on purpose: that turn
 * was authored by another agent, so matching one to our send would confirm a
 * delivery that never happened.
 */
const USER_KINDS: readonly string[] = ['prompt', 'command']

/**
 * Trailing/leading whitespace + CRLF collapsed; nothing else.
 *
 * The transcript echoes the prompt VERBATIM (a0 §5), so an aggressive
 * normaliser (case-folding, inner-whitespace collapsing) would let one pending
 * claim another's entry in a session that sends near-identical text twice —
 * which shows up as the wrong message quietly vanishing.
 */
export function normalizeSend(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** Does this confirmed entry text answer for that sent text? */
function claims(sent: string, confirmed: string): boolean {
  if (sent === confirmed) return true
  // The wire's 8000-char truncation, inverted — and only in that direction, so
  // a short entry can never claim a long send by accident.
  return (
    sent.length > PROMPT_CLAMP_CHARS &&
    sent.slice(0, PROMPT_CLAMP_CHARS).trimEnd() === confirmed
  )
}

/**
 * Could this entry be the echo of THIS send — i.e. did it arrive after it?
 *
 * Novelty first and clocks second, deliberately: the uuid answer is exact and
 * needs no clock at all, and the stamp answer is only reached for a send made
 * before the transcript had ever loaded — where there is, by construction, no
 * older entry on screen for it to be confused with.
 */
function isAfterSend(
  p: PendingSend,
  uuid: string,
  ms: number,
  nowMs: number,
): boolean {
  if (p.seen) return !p.seen.has(uuid)
  return ms >= p.atMs - CONFIRM_SKEW_MS && ms <= nowMs + FUTURE_TOLERANCE_MS
}

/**
 * Which pending gets first refusal on a matching entry.
 *
 * Oldest first — the FIFO rule that keeps a session which sends "ping" twice
 * from reconciling both echoes against the first arrival — EXCEPT that a send
 * this surface has already declared failed goes to the back of the queue.
 *
 * Why the exception is load-bearing: a rejected POST leaves the words in the
 * composer AND an `undelivered` row on screen, so the user's own recovery is
 * usually a second Enter rather than the Retry button — two pendings, same
 * text, and only the second one is really in the pty. Under plain FIFO the
 * dead one claims the transcript echo, so the failure notice quietly vanishes
 * and the message that DID land is the one accused of not arriving — for good,
 * because no second entry is ever coming for a POST that was refused. Same
 * reasoning for a watchdog escalation: a send that had its whole quiet window
 * to appear and didn't is the worse candidate for an echo arriving now.
 */
function claimRank(p: PendingSend): number {
  return p.state === 'undelivered' ? 1 : 0
}

/**
 * Drop every pending whose text matches an unclaimed user entry stamped at or
 * after (atMs − CONFIRM_SKEW_MS). ONE ENTRY CLAIMS AT MOST ONE PENDING, in the
 * `claimRank` order above.
 *
 * Survivors come back oldest-first. `entries` is the newest-first wire list.
 */
export function reconcile(
  pending: readonly PendingSend[],
  entries: readonly ChatEntry[],
  nowMs: number,
): PendingSend[] {
  const byAge = [...pending].sort((a, b) => a.atMs - b.atMs)
  if (byAge.length === 0) return byAge
  // Stable, so age still decides inside a rank.
  const ordered = [...byAge].sort((a, b) => claimRank(a) - claimRank(b))

  const candidates = entries
    .filter((e) => USER_KINDS.includes(e.kind))
    .map((e) => ({ uuid: e.uuid, ms: e.ts * 1000, text: normalizeSend(e.text) }))
    // Chronological, so "oldest pending takes the oldest matching entry" is a
    // single pass rather than a search.
    .sort((a, b) => a.ms - b.ms)

  const taken = new Set<string>()
  // By identity, not by id: two rows sharing an id would be a store bug, and it
  // must not become a reconcile bug that drops a live send off the screen.
  const claimed = new Set<PendingSend>()
  for (const p of ordered) {
    const sent = normalizeSend(p.text)
    const hit = candidates.find(
      (c) => !taken.has(c.uuid) && isAfterSend(p, c.uuid, c.ms, nowMs) && claims(sent, c.text),
    )
    if (!hit) continue
    taken.add(hit.uuid)
    claimed.add(p)
  }
  // Back into age order: claim priority decides WHO reconciles, never how the
  // survivors are drawn.
  return byAge.filter((p) => !claimed.has(p))
}

/* ── the server's own delivery receipt ────────────────────────────────────── */

/**
 * `set_last_send` (`db/sessions.rs`) is written by `POST /send` AFTER the paste
 * and the Enter, and it is broadcast on the session delta. It is therefore a
 * receipt for the one thing this client cannot otherwise know: whether a send
 * whose HTTP response never came back nevertheless arrived.
 *
 * Why that matters more than it sounds: a dropped response leaves the row
 * `undelivered` with a Retry button, and Retry on a message the server already
 * typed sends "revert the migration and redeploy" to the agent twice (A4
 * review). The receipt is also what covers a queued mid-turn send whose
 * transcript echo is minutes away, and one that has fallen out of the 30-entry
 * recall window entirely.
 *
 * It is compared against a BASELINE captured at submit time, never against a
 * clock: "the session's last send is newer than the one it had when I pressed
 * Enter, and it says what I sent". Both stamps are the server's own, so no skew
 * estimate can move the answer.
 */
export interface SendReceipt {
  /** `last_send_text` — the first `PROMPT_CLAMP_CHARS` of the last text the
   *  server typed into this pty. */
  text: string
  /** `last_send_at`, epoch SECONDS on the server's clock. */
  atS: number
}

/** Does the server's receipt answer for this send? */
export function receiptClaims(p: PendingSend, receipt: SendReceipt | null): boolean {
  if (!receipt || !receipt.text || !receipt.atS) return false
  // Not newer than the receipt this send was made against → it is the PREVIOUS
  // send's receipt. (`last_send_at` has 1s granularity, so two sends inside one
  // second yield no receipt for the second — a false negative, which costs
  // nothing but the pre-existing watchdog behaviour.)
  if (receipt.atS <= (p.receiptAtS ?? 0)) return false
  return claims(normalizeSend(p.text), normalizeSend(receipt.text))
}

/**
 * Fold a receipt into the store: mark what the server confirms it delivered,
 * and TAKE BACK an escalation the receipt disproves.
 *
 * Un-escalating is not a softening of the "once said, it stays said" rule —
 * that rule exists so a failure cannot be healed by a guess. This is evidence:
 * the server states it typed the text. Leaving the accusation up would leave a
 * Retry button over a message that landed, which is how the duplicate happens.
 *
 * Same reference back when nothing moved.
 */
export function applyReceipt(
  pending: readonly PendingSend[],
  receipt: SendReceipt | null,
): readonly PendingSend[] {
  if (!receipt) return pending
  let changed = false
  const next = pending.map((p) => {
    if (p.receipted || p.state === 'sending') return p
    if (!receiptClaims(p, receipt)) return p
    changed = true
    return p.state === 'undelivered'
      ? {
          ...p,
          receipted: true,
          state: 'unconfirmed' as const,
          note: 'It reached the session after all.',
        }
      : { ...p, receipted: true }
  })
  return changed ? next : pending
}

/**
 * What an unconfirmed echo SAYS — the delivery receipt, in words.
 *
 * "Sending…" is a lie the moment the POST has returned: the app is not sending
 * any more, it is waiting. What it is waiting FOR depends on the one piece of
 * evidence this branch actually has — `set_last_send`, written by `POST /send`
 * AFTER the paste and the Enter and broadcast on the session delta. That is the
 * server stating it typed the text into the pty, which is precisely the fact a
 * mid-turn send needs: Claude Code queues it, and the transcript echo can be
 * minutes away.
 *
 * WHY NOT CLAUDE CODE'S OWN QUEUE RECEIPT. A0 measured the `queue-operation`
 * `enqueue` line on disk 158 ms after the POST, and it carries the queued text
 * verbatim — a far better receipt than this one. It does not reach this client
 * on this branch: `recall.rs read_chat_turns` emits `user`/`assistant`/title
 * lines only, so no `queue-operation` entry is ever parsed, and A4's own plan
 * puts that server change in T8 (unimplemented here) with A2's WS parser
 * superseding it. Rather than draw a queue pill from an optimistic guess, the
 * row states the receipt it can prove and names the turn it is behind.
 *
 * A2-SEAM: when the chat WS emits `queued` entries, this line becomes "queued
 * behind N" and the pill grows a position; the receipt below stays as the
 * fallback for the window before the first frame arrives.
 */
export function deliveryLine(p: PendingSend, ctx: { active: boolean }): string {
  if (!p.receipted) return 'Sending…'
  return ctx.active
    ? 'The session has it — Claude is mid-turn, so it’s queued behind the running turn.'
    : 'The session has it — waiting for the transcript to catch up.'
}

/** How long a send may go unconfirmed before the surface says so. */
export const WATCHDOG_MS = 5_000

/**
 * No matching entry AND no evidence of life since the send → undelivered.
 *
 * The plan's phrasing for this is "regardless of status", and that is true of
 * the SIGNATURE — status is not an argument — but not of the outcome: the
 * caller's `sawActiveSince` is fed from the session's status, so a send made
 * during a long turn is held at `unconfirmed` for as long as the turn runs. The
 * honest statement of the limitation, since this module's own comment used to
 * claim the opposite: a send the TUI drops mid-turn is not escalated until the
 * turn ends. The receipt above is what closes that window when the server got
 * the text; T8's queue receipt closes the rest.
 *
 * Status is not an argument here, and that is the design. A session that reads
 * `active` because a previous turn is still running says nothing about whether
 * THIS send arrived; a session that reads `idle` may simply not have started
 * yet. Only evidence counts, and `sawActiveSince` is the caller's report of it.
 *
 * WHAT THE PROBE IS ASKED, and why it is a ROLLING window rather than the flat
 * "was there an Active transition after the send" the plan sketches: the probe
 * is asked for aliveness that is BOTH after the send AND inside the last
 * `WATCHDOG_MS`. That single `max()` is what makes two real cases come out
 * right, and the flat version gets one of them wrong either way:
 *   · a send made MID-TURN is queued by Claude Code and produces no transcript
 *     entry until the queue is consumed — minutes, legitimately. A running turn
 *     is live evidence that the session took the keystrokes, so the deadline
 *     rolls forward with it and the echo waits instead of crying wolf (the
 *     queue's own receipt is T8's; when it lands this becomes CONFIRMED rather
 *     than merely un-escalated).
 *   · a turn that ENDS without the send ever appearing stops producing
 *     evidence, so the deadline stands still and the echo escalates ~5s later —
 *     with those 5s covering the turn-end refetch that is at that moment on its
 *     way. Aliveness DEFERS the verdict; it never cancels it.
 *
 * Two states are terminal on purpose:
 *   · `sending` — the POST has not come back. Escalating it would offer a Retry
 *     that double-sends the text the server is at that moment typing into the
 *     pty (`send_text` appends the Enter itself).
 *   · `undelivered` — once said out loud it stays said, until the user retries
 *     or dismisses it. A failure that heals itself on the next tick teaches the
 *     user to ignore the next one.
 */
export function watchdogState(
  p: PendingSend,
  ctx: { nowMs: number; sawActiveSince: (ms: number) => boolean },
): PendingState {
  if (p.state !== 'unconfirmed') return p.state
  // The server said it typed this into the pty. There is nothing left for the
  // watchdog to be honest about — the message is in the session, and the only
  // open question is when the transcript will echo it (a queued prompt can sit
  // there for minutes). Escalating past a receipt would offer a Retry that
  // duplicates a delivered message.
  if (p.receipted) return 'unconfirmed'
  if (ctx.nowMs - p.atMs < WATCHDOG_MS) return 'unconfirmed'
  const since = Math.max(p.atMs, ctx.nowMs - WATCHDOG_MS)
  return ctx.sawActiveSince(since) ? 'unconfirmed' : 'undelivered'
}

/**
 * Write an escalation `watchdogState` has already decided back into the list.
 *
 * Without this the terminal-state guard above is only true of the state it is
 * HANDED: the store still says `unconfirmed`, so the next second in which the
 * session reads active again — the user going to look at the pty and typing
 * there is enough — quietly un-escalates a failure the surface had already
 * stated, and the Retry button appears and disappears under the cursor.
 *
 * Returns the same reference when nothing moved: the caller runs this off its
 * own output.
 */
export function latchUndelivered(
  pending: readonly PendingSend[],
  ids: ReadonlySet<string>,
): readonly PendingSend[] {
  let changed = false
  const next = pending.map((p) => {
    if (p.state !== 'unconfirmed' || !ids.has(p.id)) return p
    changed = true
    return { ...p, state: 'undelivered' as const }
  })
  return changed ? next : pending
}
