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

import { newestAgentTs, type ChatEntry } from './entries'

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
   * The failure was a TRANSPORT failure — the POST left this client but no
   * response came back (`SessionError` status 0: `fetch` threw, or the server
   * went away mid-request). Unlike a server REFUSAL (a 409 with a definite
   * body), a status-0 failure is genuinely AMBIGUOUS about delivery: the
   * request may have reached the pty and been typed, with only the reply lost
   * on the flaky link — the exact lost-response case behind the false
   * "Can't reach supermux-server" over a message that was delivered AND
   * answered.
   *
   * It is what lets `settleUndelivered` clear ONLY a lost-response row on
   * transcript evidence while a hard refusal keeps its verdict: a 409 said
   * "no", so no amount of later agent output confirms a delivery that the
   * server itself declined.
   */
  transportError?: boolean
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
  /**
   * The client-generated idempotency key carried on `POST /send` (`send_id`).
   *
   * Stable across the send AND its retries: the server dedups on it, so a Retry
   * (or a mis-tapped double-send) of a message it already typed is a no-op
   * instead of a duplicate prompt in the agent's queue. Never a server id — it
   * is minted here, before the POST, precisely so it survives a POST whose
   * response never comes back.
   */
  sendId?: string
  /** The SERVER confirmed it typed this text into the pty (`set_last_send`,
   *  written by `/send` after the paste + Enter). Transport-independent, so it
   *  survives exactly the failure the watchdog cannot see through. */
  receipted?: boolean
  /**
   * Was a turn ALREADY running when this send left?
   *
   * Captured at submit time, and it is the difference between two sentences that
   * are not both true. "Queued behind the running turn" is a fact about a turn
   * that was there BEFORE this message; ~200ms after a send into an idle
   * session the status flips to active because of THIS message, and the row then
   * announced that it was queued behind itself (daily-driver QA #10 measured the
   * flip at 228ms, on a session that was idle when Enter was pressed).
   *
   * The status at render time cannot answer this — it has already moved. The
   * status at SEND time can, and it never changes afterwards.
   */
  activeAtSend?: boolean
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
 * The display kinds a promoted/echoed USER message can carry — the candidates
 * `reconcile` matches an optimistic send against in the confirmed transcript.
 * This is the user-INITIATED set `wire-entries.ts::SURVIVING_KINDS` keeps (the
 * twin of `recall.rs::Kind::is_user_initiated`) MINUS `teammate`, plus the
 * `notification`/`image` wrapper kinds `toDisplayList` also draws as `user`.
 *
 * `teammate` is excluded on purpose: that turn was authored by ANOTHER agent,
 * so matching one to our send would confirm a delivery that never happened.
 *
 * The rest are all a deliberate human action on THIS session's behalf — a typed
 * prompt, a slash `command`, a colleague's `@`-handoff (`delegation`), a
 * `schedule` this owner set earlier, an attached `image`, a `notification`. The
 * previous list was `['prompt', 'command']` only, so a queued send Claude Code
 * promoted to a `delegation`/`schedule` (or any non-`prompt`) user entry stayed
 * invisible to `reconcile` and its optimistic row parked forever BESIDE the
 * confirmed bubble — the #13 duplicate. Every kind here renders as one `user`
 * bubble in `toDisplayList`, so reconciling against it removes the placeholder
 * and leaves the transcript copy as the sole survivor.
 */
const USER_KINDS: readonly string[] = [
  'prompt',
  'command',
  'delegation',
  'schedule',
  'notification',
  'image',
]

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
 * BURST BACK-FILL (the false-"didn't reach" fix). `last_send`/`last_send_at` is
 * a single last-writer-wins scalar: when several sends are POSTed inside one
 * turn, only the LAST one's text survives in the receipt, so only the last is
 * text-matched here. The earlier members lose their receipt — their text was
 * overwritten and/or their `last_send_at` collides at 1-second granularity —
 * and later escalate to the false "This didn't reach the session" even though
 * they were delivered and answered.
 *
 * They WERE delivered, and the receipt proves it: `POST /send` is processed
 * SERIALLY under a per-session lock and `last_send_at` is monotonic, so once the
 * server confirms ANY send at `receipt.atS`, every OLDER still-`unconfirmed`
 * send (its own POST resolved 200, and it was submitted before this one) was
 * necessarily typed into the pty before it. So when the receipt text-matches a
 * pending, back-fill the receipt onto every older `unconfirmed` send too: they
 * all become "queued behind that turn" (the correct line), and — being
 * `receipted` — none escalates and none offers the duplicating Retry.
 *
 * Restricted to `unconfirmed` on purpose: an `undelivered` earlier send may be
 * a genuinely REFUSED one (a 409 rejected its POST, and no `last_send` was ever
 * written for it), which the atS ordering alone must not confirm. Only an exact
 * text match (via `receiptClaims`) un-escalates an `undelivered` row.
 *
 * Same reference back when nothing moved.
 */
export function applyReceipt(
  pending: readonly PendingSend[],
  receipt: SendReceipt | null,
): readonly PendingSend[] {
  if (!receipt) return pending
  // The newest send the receipt text-matches. Older `unconfirmed` sends were
  // serialized ahead of it, so they are delivered too. `-Infinity` = the receipt
  // matched nothing, so there is no burst to back-fill and behaviour is exactly
  // as before (a receipt for text no pending sent confirms nothing).
  let matchedMaxAtMs = -Infinity
  for (const p of pending) {
    if (p.receipted || p.state === 'sending') continue
    if (receiptClaims(p, receipt) && p.atMs > matchedMaxAtMs) matchedMaxAtMs = p.atMs
  }
  let changed = false
  const next = pending.map((p) => {
    if (p.receipted || p.state === 'sending') return p
    if (receiptClaims(p, receipt)) {
      changed = true
      return p.state === 'undelivered'
        ? {
            ...p,
            receipted: true,
            state: 'unconfirmed' as const,
            note: 'It reached the session after all.',
          }
        : { ...p, receipted: true }
    }
    // Back-fill: an older unconfirmed send from the same burst.
    if (p.state === 'unconfirmed' && p.atMs < matchedMaxAtMs) {
      changed = true
      return { ...p, receipted: true }
    }
    return p
  })
  return changed ? next : pending
}

/**
 * Settle-and-REMOVE a receipted row the transcript has demonstrably moved past —
 * the window-eviction exit `applyReceipt` was missing, and the core of #45.
 *
 * `receipted` proves the server typed the text into the pty. It correctly stops
 * the false "didn't reach the session" escalation, but it also pins the row at
 * `unconfirmed` FOREVER (`watchdogState`, "if (p.receipted) return
 * 'unconfirmed'"), and its only removal path is `reconcile` matching the
 * promoted user echo in the confirmed transcript. On a long, tool-heavy turn
 * (Claude runs 30–100 calls/turn) that echo is buried below — or evicted
 * entirely from — the bounded recall window before `reconcile` ever sees it, so
 * the row parks on "queued behind that turn" with a live receipt line under an
 * answer that has already come and gone. That is the reported IMG_2441 stuck
 * state: delivered AND answered, yet the optimistic row never clears.
 *
 * The exit: a receipted send whose message has DEMONSTRABLY been handled is
 * done, echo in-window or not. "Handled" = the session has since returned to
 * IDLE and an agent turn produced output stamped AFTER the send. Claude Code
 * drains its input queue at the turn boundary (a0-findings §5: enqueue →
 * dequeue → the promoted `user` entry, same text → the answer), so `receipted` +
 * a newer agent turn + no turn still running is exactly "delivered and
 * answered".
 *
 * WHY IDLE IS LOAD-BEARING, and not the `newestAgentTs > send` test on its own:
 * a send QUEUED behind a still-running turn is GENUINELY still queued, and that
 * turn is itself emitting agent entries stamped after the send. Clearing on
 * those would yank the correct "queued behind that turn" indicator out from
 * under a message that has not been reached yet — the exact live state the row
 * exists to show. While the queued-behind turn runs the session reads active, so
 * this stays its hand; it fires only once the queue has drained to idle, which
 * cannot happen before the message has been consumed. Idle here DEFERS a
 * removal, it never manufactures one: the delivery is already PROVEN by
 * `receipted`, never inferred from status (the module's inverted-detection rule
 * is intact — status only ever holds a removal back, never asserts one).
 *
 * Same reference back when nothing settled — the caller runs this off its own
 * output and must not loop.
 */
export function settleReceipted(
  pending: readonly PendingSend[],
  entries: readonly ChatEntry[],
  ctx: { active: boolean },
): readonly PendingSend[] {
  // A turn is still running: any queued send is legitimately still queued, and
  // an agent entry after it belongs to the turn it is queued behind. Wait.
  if (ctx.active) return pending
  // `newestAgentTs` is epoch SECONDS (0 when the tail has no agent turn); the
  // row's stamp is server-clock ms. No agent output after the send yet ⇒ no
  // answer to settle against.
  const agentMs = newestAgentTs(entries) * 1000
  if (agentMs === 0) return pending
  let changed = false
  const next = pending.filter((p) => {
    if (p.receipted && agentMs > p.atMs) {
      changed = true
      return false
    }
    return true
  })
  return changed ? next : pending
}

/** Is any USER-initiated entry stamped at/after this send (within the wire's
 *  truncation skew)? Then a matching echo — this send's OWN, or a LATER send's —
 *  is visible, and `reconcile` is the one allowed to act on it. Used to keep the
 *  eviction exit below OUT of every case `reconcile` can already decide, so it
 *  fires only in the true window-eviction gap. */
function hasUserEntryAfter(entries: readonly ChatEntry[], atMs: number): boolean {
  return entries.some(
    (e) => USER_KINDS.includes(e.kind) && e.ts * 1000 >= atMs - CONFIRM_SKEW_MS,
  )
}

/**
 * Settle-and-REMOVE a LOST-RESPONSE row whose delivery the transcript has since
 * proven, when its own echo has been EVICTED from the recall window — the
 * transport-error twin of `settleReceipted`, and the core of the second false
 * "Can't reach supermux-server" (IMG_2451).
 *
 * The stuck state: a send whose POST reached the server (typed, queued, ANSWERED)
 * but whose HTTP RESPONSE was lost on a flaky link. `input.submit` rejects with a
 * status-0 `SessionError`, so the row escalates to `undelivered` with the
 * "Can't reach supermux-server. Retry / Dismiss" line — over a message that
 * landed and was answered. `applyReceipt` clears this the moment the server's
 * `last_send` receipt still names the text; `reconcile` clears it the moment the
 * echo is in the window. Both are defeated together on a long, tool-heavy turn
 * (Claude runs 30–100 calls/turn): the promoted user echo is evicted from the
 * bounded window before `reconcile` sees it, and a LATER send has overwritten the
 * single last-writer-wins receipt scalar. The row then parks forever with a false
 * failure and a duplicating Retry, exactly the #45 eviction gap — but for the
 * undelivered state `settleReceipted` deliberately never touches.
 *
 * The exit, and why each gate is load-bearing for the ONE guarantee that must
 * not bend — a genuinely-lost send (POST failed, never delivered) STILL says so:
 *   · `transportError` — ONLY a status-0 lost-response row. A hard refusal (409)
 *     is a definite server "no"; later agent output never confirms a delivery the
 *     server itself declined.
 *   · `activeAtSend === false` — the send was made into an IDLE session. A
 *     genuinely-lost send into an idle session types nothing, so the session
 *     produces NO turn and no agent output after it — the row correctly stays.
 *     A send made MID-TURN is excluded outright: the running turn's own output is
 *     trivially "after the send" and proves nothing about THIS message.
 *   · `!ctx.active` + `agentMs > p.atMs` — the session has returned to idle AND
 *     an agent turn produced output after the send: something ran and finished.
 *   · `ctx.sawActiveSince(p.atMs)` — the aliveness ledger witnessed the session
 *     go active AFTER the send. Delivery into idle is what turns the session
 *     active; a lost send into idle never does (nothing was typed), so this is
 *     false and the row stays.
 *   · `!hasUserEntryAfter` — the decisive attribution guard. If ANY user echo is
 *     visible after the send (this send's own, or a LATER send's), the answer may
 *     belong to that other send, and `reconcile` — not this — owns that case. So
 *     this fires ONLY when no user echo is in the window at all, i.e. the true
 *     eviction gap, and can never mistake a later message's turn for this one's.
 *
 * The residual it does NOT cover, stated plainly: a lost idle send whose turn was
 * started instead by a `teammate` handoff (the one user-ish kind outside
 * `USER_KINDS`) landing in the same window could be cleared on that turn's
 * output. That is a rare cross-author coincidence, not the reported bug; every
 * self-authored path (prompt / command / delegation / schedule / notification /
 * image) is caught by `hasUserEntryAfter` and deferred to `reconcile`.
 *
 * Same reference back when nothing settled — the caller runs this off its own
 * output and must not loop.
 */
export function settleUndelivered(
  pending: readonly PendingSend[],
  entries: readonly ChatEntry[],
  ctx: { active: boolean; sawActiveSince: (ms: number) => boolean },
): readonly PendingSend[] {
  if (ctx.active) return pending
  const agentMs = newestAgentTs(entries) * 1000
  if (agentMs === 0) return pending
  let changed = false
  const next = pending.filter((p) => {
    if (p.state !== 'undelivered' || !p.transportError) return true
    if (p.activeAtSend !== false) return true
    if (agentMs <= p.atMs) return true
    if (!ctx.sawActiveSince(p.atMs)) return true
    // Any user echo in the window (this send's or a later one's) → reconcile's.
    if (hasUserEntryAfter(entries, p.atMs)) return true
    changed = true
    return false
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
 *
 * ONE EXPLANATION PER STATE (daily-driver QA #10). The queue sentence is keyed
 * off the turn that was running when the message LEFT, not off the session's
 * status right now: the status flips ~200ms after a send into an idle session,
 * and reading it here made the row say the message was "queued behind the
 * running turn" when the running turn was the message itself. A line that
 * contradicts the one printed 100ms earlier teaches the user to read neither.
 *
 * `ctx.active` therefore no longer decides anything. It stays in the signature
 * as the fallback for a send made before this field existed (a row restored from
 * the module store across a renderer toggle), and only agrees with `activeAtSend`
 * when nothing has flipped.
 */
export function deliveryLine(p: PendingSend, ctx: { active: boolean }): string {
  if (!p.receipted) return 'Sending…'
  const queued = p.activeAtSend ?? ctx.active
  return queued
    ? 'The session has it — Claude was mid-turn, so it’s queued behind that turn.'
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
  ctx: { nowMs: number; sawActiveSince: (ms: number) => boolean; planeDown?: boolean },
): PendingState {
  if (p.state !== 'unconfirmed') return p.state
  // A6 T2.5 — the watchdog measures ECHO ARRIVAL IN THE TRANSCRIPT, and the
  // transcript arrives over the chat socket. When that socket is the thing
  // that is down, the absence of an echo is evidence about the socket and
  // about nothing else, so escalating manufactures a false "undelivered" for a
  // message that very likely arrived: `POST /send` is an independent REST path
  // that succeeds perfectly well while the WS is dead.
  //
  // A false undelivered is the worst possible outcome here — it teaches the
  // user that the honesty mechanism lies, which is the exact opposite of what
  // T2 is for. The surface says which plane is down instead (`ConnectionNote`),
  // and the send stays `unconfirmed` until the socket comes back and the echo
  // either lands or does not.
  if (ctx.planeDown) return 'unconfirmed'
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

/* ── one owner per failed send ─────────────────────────────────────────────── */

/**
 * Errors whose failure is ALREADY STATED on the transcript row.
 *
 * A refused send used to be announced three times at once: the inline row under
 * the failed bubble (the server's sentence + Retry / Open terminal / Dismiss),
 * the attention card, and the composer's banner repeating the same sentence
 * with its own Dismiss — ~330px, roughly 40% of the reading column at
 * 1440x900, pushing the conversation off screen and putting the reason string
 * in `body.innerText` twice on a phone.
 *
 * The inline row wins, because it is anchored to the thing that failed and it
 * already carries Retry. So the tracked `submit` marks the error it rethrows,
 * and the composer's banner stays quiet for a failure that already has a row.
 * A send with no row of its own — an untracked input plane — is unmarked, and
 * the banner still speaks for it.
 *
 * A `WeakSet` rather than a field on the error: the object belongs to the
 * caller (it can be a server `Error`, a `DOMException`, anything `fetch`
 * rejects with), and marking it must not be visible to anyone reading it.
 */
const INLINE_OWNED = new WeakSet<object>()

/** Mark `err` as reported by an inline pending row, and hand it back so it can
 *  be rethrown in place. A non-object rejection is wrapped, so the marker holds
 *  for the `throw 'string'` case too without losing the message. */
export function markInlineOwned(err: unknown): unknown {
  const obj = typeof err === 'object' && err !== null ? err : new Error(String(err))
  INLINE_OWNED.add(obj)
  return obj
}

/** Whether this failure is already stated on a transcript row. */
export function isInlineOwned(err: unknown): boolean {
  return typeof err === 'object' && err !== null && INLINE_OWNED.has(err)
}
