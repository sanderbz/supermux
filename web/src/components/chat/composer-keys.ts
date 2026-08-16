// What a keystroke MEANS in a composer, and in the list under it.
// ─────────────────────────────────────────────────────────────────────────────
// PURE AND IMPORT-FREE (fase B3 T3.3). It was born inside `use-composer.ts`,
// where it was already extracted from the component so the IME matrix could be
// asserted without a DOM. B3 moved it out of the hook FILE as well, for a
// reason the hook's own size makes obvious: the scheduler's `PromptField` now
// answers the same keys, and importing this from an 800-line hook module put
// that hook — plus React, plus `delegate-intent`, plus the session-input
// plumbing — on the scheduler chunk's import graph.
//
// A reducer that two surfaces share has to live somewhere neither of them owns.
// That is the whole argument, and the app-JS budget is what made it concrete.
//
// The alternative — a second reducer beside this one — is the exact
// duplication fase B3 exists to delete: four hand-rolled keyboard engines, one
// of which had already lost its `scrollIntoView` by copy-paste drift.

// ── The key contract ────────────────────────────────────────────────────────

/** What a keystroke MEANS in the composer. Extracted from the component so the
 *  IME matrix can be asserted without a DOM (`chat-interactive.test.tsx`).
 *
 *  The four `picker-*` intents exist only while the `@`/`/` popover is open
 *  (fase A4 T9) — they are what keeps ONE ESCAPE, ONE MEANING true once a
 *  second thing on this surface can be closed. */
export type ComposerIntent =
  | 'submit'
  | 'newline'
  | 'stop'
  | 'clear'
  | 'pass'
  | 'picker-up'
  | 'picker-down'
  | 'picker-accept'
  | 'picker-close'
  | 'picker-page-up'
  | 'picker-page-down'
  | 'picker-first'
  | 'picker-last'

/** The shape a React keydown event and a plain object both satisfy. */
export interface ComposerKeyEvent {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
  isComposing?: boolean
}

function composing(e: ComposerKeyEvent): boolean {
  // `isComposing` is the standard; keyCode 229 is the Android/GBoard fallback
  // the repo already relies on in two places (`hooks/use-live-term.ts:1349`,
  // `lib/android-ime.ts`) because soft keyboards deliver nearly everything as
  // composition and some of them never set `isComposing` on the keydown that
  // commits. Enter during composition is the IME's own "accept this candidate",
  // NOT a submit — treating it as one is how a chat box sends half a word in
  // Japanese, and every keystroke in Korean.
  return (
    e.isComposing === true ||
    e.nativeEvent?.isComposing === true ||
    e.keyCode === 229 ||
    e.nativeEvent?.keyCode === 229
  )
}

/**
 * The whole keyboard contract, as data.
 *
 *   Enter                 → submit (unless composing — then the IME owns it)
 *   Shift+Enter           → newline
 *   Escape, draft present → clear the draft
 *   Escape, draft empty   → stop the turn, when there is one
 *
 * ONE ESCAPE, ONE MEANING: with text in the box Escape clears the box; with an
 * empty box it interrupts the agent. Doing both on one press would make "I
 * changed my mind about this sentence" occasionally kill a running turn.
 */
export function composerKeyIntent(
  e: ComposerKeyEvent,
  ctx: { draft: string; active: boolean; picker?: boolean; caret?: boolean },
): ComposerIntent {
  // A COMPOSITION OWNS EVERY KEY IT IS GIVEN, not just Enter. Escape during an
  // IME composition means "cancel this conversion" — swallowing it to clear the
  // draft would throw away the whole message on the keystroke a CJK typist uses
  // dozens of times a paragraph, and `preventDefault` would leave the candidate
  // window stranded. Same reason keyCode 229 is honoured: on Android nearly
  // everything arrives as composition.
  if (composing(e)) return 'pass'
  // THE POPOVER OWNS ITS OWN KEYS while it is open (fase A4 T9). Escape is the
  // one that matters: with a picker up, Escape closes the PICKER — it does not
  // also clear the draft and it certainly does not stop the turn. One escape,
  // one meaning, even when there are two things to escape from.
  if (ctx.picker) {
    if (e.key === 'ArrowUp') return 'picker-up'
    if (e.key === 'ArrowDown') return 'picker-down'
    if (e.key === 'Escape') return 'picker-close'
    if (e.key === 'Tab' && !e.shiftKey) return 'picker-accept'
    // PageUp/PageDown are always the list's (fase B3 T1.2). In a 1–3 line
    // composer they do nothing a user wants — the browser scrolls the
    // TRANSCRIPT out from under the sentence being written — so taking them
    // costs nothing and gives a 40-row list a coarse gear.
    if (e.key === 'PageUp') return 'picker-page-up'
    if (e.key === 'PageDown') return 'picker-page-down'
    // HOME/END BELONG TO THE CARET, and the token anchor sits on a textarea
    // where the caret is the whole point: `@foo` is typed INSIDE a sentence,
    // and stealing Home to jump a suggestion list would strand a user who
    // wanted the start of their own line. The FIELD anchor (`caret: false` —
    // the palette, a sheet's filter box) has no such claim: its input holds a
    // query, not prose, so there Home/End address the list.
    //
    // This is the one cell of the truth table where the two anchors disagree,
    // and it is why the anchor is a parameter of the reducer rather than a
    // second reducer.
    if (ctx.caret === false) {
      if (e.key === 'Home') return 'picker-first'
      if (e.key === 'End') return 'picker-last'
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Falls back to `submit` in the hook when the list has nothing to accept
      // (a query that matches nothing must not swallow the message).
      return 'picker-accept'
    }
  }
  if (e.key === 'Enter') {
    if (e.shiftKey) return 'newline'
    // A modified Enter is somebody else's shortcut (⌘Enter is not ours yet).
    if (e.metaKey || e.ctrlKey || e.altKey) return 'pass'
    return 'submit'
  }
  if (e.key === 'Escape') {
    if (ctx.draft.length > 0) return 'clear'
    return ctx.active ? 'stop' : 'pass'
  }
  return 'pass'
}

/** How many rows a PageUp/PageDown covers. Deliberately smaller than the
 *  12-row list, so a page is a GEAR and not a synonym for Home/End. */
export const PICKER_PAGE = 5

/** Where a coarse jump lands (fase B3 T1.2). */
export type PickerJump = 'first' | 'last' | 'page-up' | 'page-down'

/**
 * The index a coarse jump selects — pure, so the truth table is a unit test.
 *
 * CLAMPED, NEVER WRAPPED, and that asymmetry with `move()` is deliberate: the
 * arrows wrap because a short list is a ring you can spin past the end and keep
 * going, but a user who presses End means "the end". A Home that wrapped to the
 * bottom, or a PageDown that silently re-entered at the top, would move the
 * highlight to somewhere the keystroke did not name.
 *
 * An empty list yields 0 rather than -1: there is no row to highlight, and the
 * callers all guard on `rows.length` first — returning a negative index here
 * would put the same "is this a real row" decision in two places.
 */
export function jumpTarget(to: PickerJump, from: number, length: number): number {
  if (length <= 0) return 0
  const last = length - 1
  const next =
    to === 'first' ? 0
    : to === 'last' ? last
    : to === 'page-up' ? from - PICKER_PAGE
    : from + PICKER_PAGE
  return Math.min(Math.max(next, 0), last)
}
