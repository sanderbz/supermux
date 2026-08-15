// SessionInput — the renderer-agnostic handle every write path in the app
// funnels through (fase A4 T1).
//
// WHY IT EXISTS. Until now every "type something into the session" surface (the
// dock, the keybar, the snippet panel, the attachment injector, the compose
// sheet) reached for `termRef.current?.send(…)` — i.e. it could only work while
// an xterm was mounted. The chat renderer has no xterm, so those surfaces
// silently no-op'd there and had to be hidden. One handle with two
// implementations (the pty byte stream / the REST input plane) turns "which
// renderer is mounted" into a prop, which is what makes A5's mobile chat seam a
// prop change rather than a rewrite.
//
// The two implementations live in `./terminal.ts` and `./rest.ts`; nothing else
// in the app is allowed to append a submit byte or name a key.

/** The keys the server will actually accept.
 *
 *  Ground truth: `KEY_ALLOWLIST` in `server/src/sessions/lifecycle.rs:1696` —
 *  anything outside it is rejected with a 400 by `send_keys`. Typed as a union,
 *  not `string`, for two reasons:
 *
 *  1. **No digits.** The allowlist has no `0`-`9`, so a modal-registry entry
 *     that wants to answer "option 3" by pressing `3` must not compile — it has
 *     to express itself as `Down`×n + `Enter` (a0-findings §8.4; widening the
 *     allowlist is an unsigned owner item and A4 does not depend on it).
 *  2. **No terminal-only key names.** `Newline`, `EscEsc`, `Ctrl-G` and friends
 *     are `keyToBytes` names understood by xterm's byte path only; sending one
 *     over REST would 400. They stay on the terminal ref, by name, where they
 *     belong (see the header of `./terminal.ts`).
 *
 *  This union is the subset of the allowlist A4 actually needs. It is a strict
 *  subset — every member below is present in `KEY_ALLOWLIST`, verified against
 *  the source. `C-g` is deliberately NOT here: the master plan's draft listed
 *  it, but the server's allowlist does not contain it, so the external-editor
 *  Ctrl+G stays a terminal-only path. */
export type KeyName =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'BTab'
  | 'Space'
  | 'BSpace'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'C-c'
  | 'C-d'
  | 'C-l'
  | 'C-r'
  | 'C-u'
  | 'y'
  | 'n'
  | 'q'

export interface SessionInput {
  /** Text + submit, atomically. The REST path posts `/send`, which appends the
   *  Enter itself (and the provider submit gap); the terminal path appends
   *  exactly one `\r`. Callers NEVER add a trailing CR of their own — that is
   *  the double-submit hazard this interface exists to remove. */
  submit(text: string): Promise<void>
  /** Text WITHOUT submit — bracketed paste on the REST plane, raw bytes on the
   *  terminal. The insert surfaces (attachments, snippets, pickers) use this. */
  insert(text: string): Promise<void>
  sendKey(name: KeyName): Promise<void>
  /** Put the caret where typing goes: xterm's hidden textarea on the terminal
   *  plane, the React composer on the REST plane. */
  focus(): void
  blur(): void
}
