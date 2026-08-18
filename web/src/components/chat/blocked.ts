/**
 * **Is this session blocked right now?** (states audit)
 * ─────────────────────────────────────────────────────────────────────────────
 * A blocked agent is NOT a status. `server/src/sessions/status.rs` decides
 * `active`/`waiting`/`idle` from the hook turn state machine FIRST, and a
 * limit-hit turn ends with a perfectly ordinary `Stop` — so the detector
 * reports `Idle`, and it is structurally incapable of reporting anything else
 * for the whole class of "Claude finished the turn but cannot do the next one".
 * The status banks cannot be taught this; the fact outlives the turn.
 *
 * So it is derived here, from the transcript, and it is what three surfaces
 * read: the composer gate, the attention card, and (through the shared
 * classifier) the roster badge.
 *
 * THE CLEARING RULE, and why it is asymmetric. A newer USER prompt does not
 * clear a block — typing into a rate-limited session is exactly what somebody
 * does when they have not noticed, and clearing on it would make the surface
 * lie the moment it mattered most. Only a newer ASSISTANT or TOOL entry clears
 * it: those are the agent proving it can work again, which is the only evidence
 * that means anything here.
 *
 * Pure and dependency-free, like `entries.ts` itself.
 */

import type { ChatEntry } from './entries'
import type { PtyNotice } from './peek-lens'

export interface BlockedState {
  /** The uuid of the banner this state was decided on. */
  uuid: string
  /** The bucket as words (`Session limit`, `Opus limit`, `Signed out`). */
  label: string
  /** Claude Code's own sentence, verbatim. */
  text: string
  /** `Resets 4:40am (Europe/Amsterdam)`, when the bucket has a clock. */
  resets?: string
}

/**
 * The newest un-cleared blocking banner, or `null`.
 *
 * `entries` is the renderer's NEWEST-FIRST list (`toChatEntries`), so the walk
 * is forwards and the first answer is the right one.
 */
export function blockedState(entries: readonly ChatEntry[]): BlockedState | null {
  for (const e of entries) {
    // The agent has spoken or run a tool since — it is working again. This is
    // the ONLY recovery evidence that clears a wall (see the file header): a
    // newer prompt is somebody who has not noticed, and a newer failed attempt
    // is not the agent proving it can work.
    if (e.kind === 'assistant' || e.kind === 'tool_use') return null
    if (e.kind !== 'blocked') continue
    // A transient failure (a 529 retry, a server-side throttle) is worth a card
    // in the transcript and is NOT worth blanking the composer for: it clears
    // itself, usually within seconds. But it is ALSO not recovery — so it is
    // SKIPPED, not returned on. Returning `null` here let a transient error that
    // landed AFTER a quota/auth wall reopen the composer while the wall still
    // applied (wave 6 #12): the newer line does not prove the bucket refilled or
    // the session signed back in, only that one more attempt failed. Keep
    // walking; if an older blocking wall is behind it, that wall is still the
    // truth, and only a real recovery above clears it.
    if (!e.blocking) continue
    return {
      uuid: e.uuid,
      label: e.label ?? 'Blocked',
      text: e.text,
      resets: e.reply,
    }
  }
  return null
}

/**
 * The newest un-answered dialog the session is WAITING ON, from the transcript
 * plane alone, or `null`.
 *
 * A `kind:'dialog'` entry with `awaitsInput` is CC's `request_user_dialog` or an
 * MCP `task_*` parked on `input_required`: the turn has not ended, no quota wall
 * was written, and — crucially — the peek lens may never fingerprint it (the
 * elicitation form family it cannot read at all, or a peek that is simply down).
 * In that case the durable transcript is the ONLY witness that a person is
 * needed, and a composer that keeps accepting sends is pasting messages into a
 * modal that drops them. This gate is that witness.
 *
 * The clearing rule is `blockedState`'s, and for the same reason: only a newer
 * ASSISTANT or TOOL entry proves the dialog was answered and the agent moved on.
 * A newer user prompt does not — typing at a waiting dialog is exactly what
 * somebody does when they have not noticed it — so it must not reopen the gate.
 */
export function awaitingInputState(entries: readonly ChatEntry[]): BlockedState | null {
  for (const e of entries) {
    // The agent has spoken or run a tool since the dialog — it was answered and
    // the turn is moving again.
    if (e.kind === 'assistant' || e.kind === 'tool_use') return null
    if (e.kind !== 'dialog' || !e.awaitsInput) continue
    // CC's own sentence for what is waiting ("an MCP task on … is waiting for
    // your input", "this session is waiting on a permission dialog"). It stands
    // alone as the label — there is no bucket/clock split to make — so it rides
    // in both slots and `blockedComposerNote` returns it verbatim.
    return { uuid: e.uuid, label: e.text, text: e.text }
  }
  return null
}

/**
 * The one line the composer says instead of accepting a message.
 *
 * It names the limit and, where there is one, the clock — because "you cannot
 * send this" without "and here is when you can" is the half of the sentence
 * that makes a user reload the page.
 */
/**
 * The SECOND plane's block, in the shape the composer gate already speaks.
 *
 * `blockedState` only ever sees the TRANSCRIPT: a `kind:'blocked'` ChatEntry is
 * produced from a parsed banner, never from the PTY lens. But a session can be
 * limit-blocked with NO matching transcript line — Claude Code prints the wall
 * on screen and the turn ends with an ordinary `Stop`, so the detector reports a
 * green Idle and the transcript carries nothing. `peek-lens` catches exactly
 * that as a `limit-blocked` `PtyNotice`, and the attention card + header chip
 * already read it — but the composer gate did not, so the field stayed live and
 * promised delivery into a bucket that is spent. This adapts the lens notice
 * into the same `BlockedState` the composer already knows how to refuse on, so
 * ONE gate covers both planes.
 *
 * Only `limit-blocked` maps: a `session-paused`/`turn-refused` notice is a
 * different fact (a modal to answer, a dead turn) with its own card, not a
 * "you cannot send" wall. `null` in → `null` out, so the caller can chain it
 * behind the transcript plane with `??`.
 */
export function lensBlockedAsBlockedState(
  notice: PtyNotice | null | undefined,
): BlockedState | null {
  if (!notice || notice.kind !== 'limit-blocked') return null
  // The lens has no label/resets split — the transcript banner does. CC's own
  // verbatim line carries the bucket AND its clock ("… weekly limit · resets
  // …"), so it stands on its own as the label with no `resets` clause to join.
  // A synthetic uuid marks the plane it came from; nothing keys off it.
  return {
    uuid: 'lens:limit-blocked',
    label: notice.text,
    text: notice.text,
  }
}

export function blockedComposerNote(state: BlockedState): string {
  // Only the leading verb is lower-cased for the join — a blanket
  // `toLowerCase()` would eat the date and the timezone
  // ("aug 17, 4am (europe/amsterdam)"), which are the two facts the clause
  // exists to carry.
  if (!state.resets) return state.label
  const clause = state.resets.charAt(0).toLowerCase() + state.resets.slice(1)
  return `${state.label} · ${clause}`
}
