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
    // The agent has spoken or run a tool since — it is working again.
    if (e.kind === 'assistant' || e.kind === 'tool_use') return null
    if (e.kind !== 'blocked') continue
    // A transient failure (a 529 retry, a server-side throttle) is worth a card
    // in the transcript and is NOT worth blanking the composer for: it clears
    // itself, usually within seconds.
    if (!e.blocking) return null
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
 * The one line the composer says instead of accepting a message.
 *
 * It names the limit and, where there is one, the clock — because "you cannot
 * send this" without "and here is when you can" is the half of the sentence
 * that makes a user reload the page.
 */
export function blockedComposerNote(state: BlockedState): string {
  // Only the leading verb is lower-cased for the join — a blanket
  // `toLowerCase()` would eat the date and the timezone
  // ("aug 17, 4am (europe/amsterdam)"), which are the two facts the clause
  // exists to carry.
  if (!state.resets) return state.label
  const clause = state.resets.charAt(0).toLowerCase() + state.resets.slice(1)
  return `${state.label} · ${clause}`
}
