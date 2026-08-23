// Answering an AskUserQuestion from chat — the ARITHMETIC.
//
// The question card (`live-layer.tsx` `QuestionCard`) is driven by the STRUCTURED
// `session.question_request` the server parses out of the tool call, NOT by the
// pty scrape the permission `DialogCard` uses — the scrape does not reliably sight
// this dialog on the current Claude Code, which is the whole bug. So the answer
// path here is deliberately small: it does not re-verify a sighting it never had.
//
// WHAT CC's AskUserQuestion UI DOES, verbatim off the live 2.1.233 capture
// (`server/tests/fixtures/pty/ask-user-question.txt`):
//
//     ❯ 1. Apple
//          A crisp and refreshing fruit
//       2. Banana
//       …
//     Enter to select · ↑/↓ to navigate · Esc to cancel
//
// The caret starts on the FIRST option (row 0), navigation is ↑/↓, commit is
// Enter. So selecting the option at row `i` is `Down` × i then `Enter` — exactly
// what `keyPlan(0, i)` produces, which is the same primitive the permission
// dialog's verified sequence is built from (`registry/plan.ts`). Reusing it keeps
// the two answer paths on one definition of "move the caret and commit".
//
// Digits are NOT sent: `1`-`9` are not in the key allowlist, and on multiSelect a
// digit would toggle rather than commit. Navigation + Enter is the plan.
//
// MULTISELECT IS DEFERRED, ON PURPOSE. A multi-select question is toggled with
// Space and confirmed with Enter; `Down×i + Enter` would submit a single choice
// and answer the wrong thing, which is worse than not answering. The card draws a
// multi-select question inert and points at the terminal (`live-layer.tsx`), and
// this module refuses it (`questionAnswerKeys` returns `[]`, `answerQuestion`
// sends nothing) so a caller cannot accidentally single-answer it.

import type { KeyName } from '../../lib/session-input/types'

import { keyPlan } from './registry'

/**
 * The key sequence that selects the option at `optionIndex` (0-based, in the
 * order `question_request.options` lists them — the same order CC draws) and
 * commits it: `Down` × index, then `Enter`.
 *
 * `[]` (send nothing) for a nonsense index — `keyPlan` is total by design, so a
 * negative or non-integer index refuses rather than throws.
 */
export function questionAnswerKeys(optionIndex: number): KeyName[] {
  return keyPlan(0, optionIndex)
}

/**
 * Send the answer for `optionIndex` down `sendKey`, one key at a time, in order.
 * Resolves with exactly what went on the wire (asserted in the unit test). Sends
 * NOTHING for a nonsense index.
 *
 * No peek verification: the card was drawn from the structured payload, not a
 * sighting, so there is nothing to re-read between keys. The transport is the
 * REST `/keys` allowlist path (`session-input`), the same one the permission
 * dialog uses.
 */
export async function answerQuestion(
  sendKey: (key: KeyName) => Promise<void>,
  optionIndex: number,
): Promise<KeyName[]> {
  const keys = questionAnswerKeys(optionIndex)
  for (const key of keys) {
    await sendKey(key)
  }
  return keys
}
