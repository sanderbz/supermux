// The `T` hotkey — a refusal ladder, as a pure function (fase A5 T7).
//
// `use-keyboard-capture.ts` today returns early unless Cmd/Ctrl is held; its
// own comment says "EVERY other key flows through to xterm", and that is the
// property a plain-key shortcut threatens. A5 adds exactly ONE plain-key
// branch, and it is mostly made of refusals.
//
// The six refusals below all mean "do NOT preventDefault", so the key reaches
// whoever wanted it. That is the whole safety argument: a hotkey that is wrong
// costs a lost keystroke, and a lost keystroke in a terminal is a wrong command
// — so this function's job is to say NO, and it only says yes when nothing else
// could possibly want the key.
//
// No DOM import: it takes an event-LIKE, which is what makes the matrix
// assertable in `bun test` (`tests/unit/chat-renderer-hotkey.test.ts`), a runner
// with no `KeyboardEvent`.

export interface HotkeyTarget {
  /** `event.target`'s tag name, upper-case. */
  tag: string
  /** Is it an `<input>`, a `<textarea>` or `[contenteditable]`? */
  editable: boolean
  /** Its `role`, if any. */
  role: string | null
}

export interface HotkeyCtx {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
  target: HotkeyTarget
  /** Is the active element inside an open `[role=dialog]` / sheet / popover? */
  inOverlay: boolean
  /** Does xterm's helper textarea currently hold focus? */
  terminalFocused: boolean
  /**
   * Did this key come from INSIDE a chat surface that is on screen?
   *
   * Not the same question as `target.editable`: the caret can sit on a
   * non-focusable container inside the panel (the transcript's scroll region,
   * the route's `<main>`), and that is precisely the state in which the key
   * reaches the document. Swallowing it there turns a sentence meant for the
   * composer into a surface flip followed by terminal input.
   */
  chatFocused: boolean
  /**
   * Did the key arrive at the renderer switch itself?
   *
   * The coarse-pointer half of the same blocker: a tap on a cell leaves the
   * caret on that cell, and the composer arm is deliberately exempt on
   * `pointer: coarse` (focusing a textarea summons the soft keyboard). So the
   * caret stays on a focused tab with the hotkey armed, and the first letter
   * typed flips the surface — after which the reveal focuses xterm and the rest
   * of the sentence is executed in the pty.
   */
  onRendererSwitch: boolean
  /** Is the chat renderer even POSSIBLE here? (`flag.ts`) */
  eligible: boolean
}

/** The key, lower-cased, that toggles the renderer. */
export const RENDERER_HOTKEY = 't'

/**
 * `true` only when all six refusals pass. The caller then — and only then —
 * calls `preventDefault()` and flips between the two CONCRETE renderers.
 *
 * `T` never selects `auto`: a hotkey should do one obvious thing, and `auto` is
 * reachable from the switch and from both menus.
 */
export function shouldToggleRenderer(c: HotkeyCtx): boolean {
  if (c.key.toLowerCase() !== RENDERER_HOTKEY) return false

  // 1. ANY MODIFIER. `⌘T` / `Ctrl+T` is *new browser tab* — capturing it would
  //    be hostile, and on a PWA it is the only way to open one. `Alt`/`Shift`
  //    combos belong to the terminal (`Alt+t` is a readline word-transpose).
  if (c.metaKey || c.ctrlKey || c.altKey || c.shiftKey) return false

  // 2. IME. `keyCode === 229` is the composing sentinel every browser sets and
  //    the one `lib/android-ime.ts` already handles; `isComposing` is the
  //    standards path. A `t` mid-composition is a phoneme, not a shortcut.
  if (c.isComposing || c.keyCode === 229) return false

  // 3. THE COMPOSER RULE. A `t` typed into a text surface is the letter T and
  //    nothing else — this is the refusal that stops "the terminal is faster"
  //    from flipping the renderer nine times.
  if (c.target.editable) return false
  if (c.target.tag === 'INPUT' || c.target.tag === 'TEXTAREA') return false
  if (c.target.role === 'textbox' || c.target.role === 'searchbox') return false

  // 4. OVERLAYS. A `t` in the entity picker's filter, the command palette or a
  //    Vaul sheet is a filter keystroke. The overlay owns the keyboard while it
  //    is up, full stop.
  if (c.inOverlay) return false

  // 5. XTERM HAS FOCUS. A `t` at a pty is a byte for the pty, and there is no
  //    reading of "I meant the shortcut" that is worth a wrong character in a
  //    shell. The consequence, stated honestly rather than discovered: from a
  //    focused terminal you leave with the switch, or by clicking out first.
  //    The existing "Capturing input" pill (`TerminalCaptureIndicator`) is
  //    already the signal that keys are going to the pty, so the rule is
  //    legible rather than mysterious.
  if (c.terminalFocused) return false

  // 5b. THE CHAT SURFACE HAS THE KEY. The mirror of refusal 5, and the one that
  //     closes the injection path: a `t` typed at a visible chat surface is a
  //     letter someone is writing, whether or not the caret happens to be in the
  //     field at that instant. Taking it flips the renderer mid-sentence and the
  //     REST of the sentence is then typed into the pty — the worst outcome this
  //     module exists to prevent, and worth more than a shortcut that is
  //     redundant with the switch two centimetres away.
  //
  //     (`arm-composer-focus.ts` is what puts the caret back in the composer, so
  //     in practice refusal 3 catches this first; this is the guard for the
  //     frames before it lands, and for the coarse pointers it is exempt on.)
  if (c.chatFocused) return false

  // 5c. THE SWITCH HAS THE KEY. Same refusal, from the control that performs the
  //     same toggle: nothing is lost by declining a shortcut whose visible
  //     equivalent is under the user's finger, and what is gained is that the
  //     caret a tap leaves behind can no longer flip the surface mid-sentence.
  if (c.onRendererSwitch) return false

  // 6. ELIGIBILITY. With no toggle to perform there is no key to swallow.
  if (!c.eligible) return false

  return true
}
