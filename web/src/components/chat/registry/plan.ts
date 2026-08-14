// The key plan (fase A4 T6) — how a chosen option becomes keystrokes.
//
// Digits are NOT sendable: `KEY_ALLOWLIST` (`server/src/sessions/lifecycle.rs`)
// has no `0`-`9`, `POST /keys {"keys":"1"}` is a 400, and a pasted digit is
// ignored by the dialog because bracketed paste is not a keypress (all three
// live-verified, a0-findings §3 / §8.4). So navigation IS the plan: `Down`/`Up`
// to the row, then `Enter`. Widening the allowlist is an unsigned owner item;
// nothing here depends on it, and when it lands this module gains a digit
// fast-path behind a capability check and every test keeps passing.
//
// Two rules, both from live evidence:
//
//  1. **From the caret's CURRENT row, never from an assumed default.** A0 watched
//     a concurrent terminal client move the caret (and resize the pty) mid-probe,
//     twice. `use-dialog-answer.ts` (T7) re-peeks between every key and aborts if
//     the caret did not move by exactly one row — this function only says which
//     keys that sequence is made of.
//  2. **No wrapping is assumed.** There is no evidence CC's option list wraps
//     from the last row to the first, so moving up uses `Up` N times, never
//     `Down` × (N−1). Guessing wrong here does not misfire by a little: it lands
//     the caret on a row nobody chose and then presses Enter on it.

import type { KeyName } from '../../../lib/session-input/types'

/** More rows than any captured dialog has, by a wide margin (both families have
 *  exactly three). A "plan" longer than this means the caret index or the target
 *  came from something this app misread, and the honest output is no keys. */
const MAX_TRAVEL = 12

/**
 * The keys that move the caret from row `from` to row `to` and commit.
 *
 * Total by design: a nonsense input returns `[]` (send nothing) rather than
 * throwing — a registry that crashes the surface takes the Attention card down
 * with it, and the whole point of the card is to be there when the reading is
 * wrong. `[]` is also the value T7 treats as "refuse".
 */
export function keyPlan(from: number, to: number): KeyName[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return []
  if (from < 0 || to < 0) return []
  const travel = to - from
  if (Math.abs(travel) > MAX_TRAVEL) return []
  const step: KeyName = travel > 0 ? 'Down' : 'Up'
  return [...Array<KeyName>(Math.abs(travel)).fill(step), 'Enter']
}

/** How many navigation keys a plan carries — i.e. how many re-peeks T7 owes it
 *  before the commit. `keyPlan(…).length - 1`, named so the sequence and its
 *  verification loop cannot drift apart.
 *
 *  CHECK THE PLAN IS NON-EMPTY FIRST. This number cannot tell a refusal from a
 *  caret already on the row — `navigationSteps([]) === navigationSteps(['Enter'])
 *  === 0` — so a caller that loops this many times and then presses its own
 *  `Enter` would turn a refusal into an accept, which on a permission dialog
 *  means running the command. Send the keys the plan actually contains. */
export function navigationSteps(plan: readonly KeyName[]): number {
  return Math.max(0, plan.length - 1)
}
