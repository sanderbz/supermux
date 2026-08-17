// The ARMED-KEY registry — the prerequisite for every automated keypress.
//
// The catalog's `generic.armed_keys` is not a screen this app draws a card for.
// It is a PRECONDITION on the two code paths that already send keys, and the
// catalog is explicit about the order: it "must land BEFORE any auto-Esc/Ctrl-C
// recovery", not after.
//
// WHAT AN ARMED SCREEN IS. Claude Code overloads a key and says so on the
// screen: `Esc again to clear`, `Press Ctrl-C again to exit`, `Press Ctrl-C
// again to stop background agents`, `Ctrl+Y to paste deleted text`. On such a
// screen the state IS the pending second keypress, so the key this app was
// about to send for its OWN purpose does something else entirely:
//
//   · the composer's Stop sends `Escape` to interrupt a turn. With `Esc again
//     to clear` showing, that Escape throws away what the human was typing in
//     the terminal — silently, with no undo the app can offer.
//   · a `Ctrl-C` recovery on a screen showing `Press Ctrl-C again to exit`
//     kills Claude Code outright. Issue #75649 records exactly that on the
//     trust gate, which is also why `startup.trust`'s escape ships `actOn:
//     false` in `./claude.ts`.
//
// THE RULE, and it is a whitelist rather than a blacklist: a key that the live
// screen has armed may be sent ONLY when this file carries an explicit mapping
// saying what the second press does on that family — and a mapping is a claim
// backed by a capture, exactly like every `actOn: true` in `./claude.ts`. There
// are currently NONE, so every armed screen refuses. That is the correct state,
// not a stub: nobody has watched a second Esc land on any of these screens, and
// this app does not press keys it has not watched.
//
// WHY BY FAMILY. `Press Esc again to exit` on the trust gate and `Esc again to
// clear` under the composer are the same token with different consequences —
// one ends the process, one loses a sentence. A mapping that said "Escape is
// fine here" without naming the screen would generalise from the harmless case
// to the fatal one.
//
// Pure and dependency-free beyond the lens' types, like the rest of `registry/`.

import type { KeyName } from '../../../lib/session-input/types'
import type { ArmedKey, DialogSighting, PeekLens } from '../peek-lens'

/**
 * Which screen an armed key was seen on.
 *
 * The dialog families, plus `composer` for the bare TUI prompt — the screen
 * with no dialog on it, which is where `Esc again to clear` and the Ctrl-C
 * exit hints actually live.
 */
export type ArmedFamily = DialogSighting['family'] | 'composer'

/**
 * An explicit claim that this app knows what a second press does on one family.
 *
 * Every field is part of the claim. `family` scopes it (see the header), `token`
 * is the arming as the screen spells it, `key` is the allowlisted key this
 * mapping licenses, and `evidence` is where somebody watched it happen — the
 * same discipline `RegistryEntry.verifiedVersions` enforces for option rows.
 */
export interface ArmedMapping {
  family: ArmedFamily
  /** Matched against `ArmedKey.token`, whitespace-normalised, case-insensitive. */
  token: RegExp
  /** Matched against `ArmedKey.action` — `clear`, `exit`, `stop background
   *  agents`. A mapping for "Escape clears the composer" must not license
   *  "Escape exits Claude Code". */
  action: RegExp
  key: KeyName
  /** The capture (or issue) that proves what the press does. */
  evidence: string
}

/**
 * The mappings. **Deliberately empty.**
 *
 * An entry here says: *on this family, with this arming showing, this app has
 * watched what the key does and will send it.* No such capture exists for any
 * armed screen — a0 and the 2.1.233 self-test both drove dialogs that were not
 * armed — so nothing is licensed, and `armedRefusal` refuses everything.
 *
 * The list is not vacuous: `mayForward` takes it as a parameter, and
 * `chat-armed-keys.test.ts` proves both directions (an armed screen refuses; the
 * same screen with a matching mapping forwards). Adding one is a code change
 * with a capture attached, which is the point.
 */
export const ARMED_MAPPINGS: readonly ArmedMapping[] = []

/** Which family the arming was seen on. A dialog on screen owns the reading —
 *  the same key means something different inside a modal than under a composer. */
export function armedFamilyOf(lens: Pick<PeekLens, 'dialog'>): ArmedFamily {
  return lens.dialog?.family ?? 'composer'
}

export interface ArmedRefusal {
  /** The arming that stopped the send, verbatim from the screen. */
  armed: ArmedKey
  family: ArmedFamily
  /** One sentence: what the screen has armed, and what this app did instead. */
  reason: string
}

/**
 * May `key` be sent into the screen this lens is reading?
 *
 * `null` = yes. Anything else is a refusal carrying the evidence, and callers
 * must surface it rather than dropping the send silently — a Stop that quietly
 * does nothing is the failure mode this whole layer exists to avoid.
 *
 * THE MATCH IS BY SCREEN FIRST, KEY SECOND. An arming whose token has no
 * allowlisted name (`Ctrl+Y to paste deleted text`) still refuses every key,
 * because what it proves is that this screen has redefined its keyboard — and
 * the honest reading of "I cannot name the key it armed" is not "so my key is
 * fine". The cost is one refused Stop on a screen with a paste hint; the
 * alternative cost is a killed process.
 */
export function armedRefusal(
  lens: Pick<PeekLens, 'armed' | 'dialog'>,
  key: KeyName,
  mappings: readonly ArmedMapping[] = ARMED_MAPPINGS,
): ArmedRefusal | null {
  if (!lens.armed.length) return null
  const family = armedFamilyOf(lens)
  for (const armed of lens.armed) {
    // An arming this app has an explicit, evidenced mapping for is exactly what
    // makes a send allowed — and only for the key that mapping names.
    const licensed = mappings.some(
      (m) =>
        m.family === family &&
        m.key === key &&
        m.token.test(armed.token) &&
        m.action.test(armed.action),
    )
    if (licensed) continue
    return { armed, family, reason: refusalSentence(armed, key) }
  }
  return null
}

/** Convenience for call sites that only need the boolean. */
export function mayForward(
  lens: Pick<PeekLens, 'armed' | 'dialog'>,
  key: KeyName,
  mappings: readonly ArmedMapping[] = ARMED_MAPPINGS,
): boolean {
  return armedRefusal(lens, key, mappings) === null
}

/**
 * The sentence a refusal wears.
 *
 * It quotes the terminal's own words, because the whole content of this refusal
 * is a fact the user can verify by looking at their session — and because "the
 * terminal has armed Esc" means nothing next to "the terminal says *Esc again
 * to clear*".
 */
function refusalSentence(armed: ArmedKey, key: KeyName): string {
  const named = armed.key === key ? `${key} is armed` : `a keypress is armed`
  return `The terminal is showing “${armed.text}”, so ${named} — sending ${key} would ${armed.action} instead of what this app meant by it. Nothing was sent; do it in the terminal.`
}
