// terminalSessionInput — the SessionInput implementation over the live pty
// WebSocket. An ADAPTER, not a shim.
//
// WHY `UseLiveTermResult` DOES NOT ITSELF IMPLEMENT `SessionInput`
// (master plan §3, restated because it is the one hazard this whole module
// exists to prevent):
//
//   Today's terminal call sites submit by writing `send(cmd + '\r')` — the CR is
//   the caller's. The REST plane's `submit` maps to `POST /send`, and
//   `lifecycle.rs send_text` appends the Enter SERVER-SIDE. If `UseLiveTermResult`
//   were declared to implement `SessionInput`, `send` and `submit` would sit on
//   one object with opposite CR ownership, and the first call site routed
//   through REST would submit twice — once for its own `\r`, once for the
//   server's Enter. So the adapter is the ONLY place a `\r` is appended, the
//   REST path never appends one, and both are pinned by tests.
//
//   `hooks/use-live-term.ts` is therefore NOT edited by A4, and the
//   terminal-only members of the handle — `tryOpenLinkAt`, `resync`, `copyAll`,
//   `copySelection`, `resize`, `scrollToBottom`, and the `keyToBytes` names that
//   have no REST equivalent (`Newline`, `EscEsc`, `Ctrl-G`) — stay reachable
//   through the existing ref, not through this interface. A raw-key joystick or
//   keybar is terminal-only by definition; it keeps using the ref.

import type { UseLiveTermResult } from '../../hooks/use-live-term'

import type { KeyName, SessionInput } from './types'

/** The slice of the live-terminal handle this adapter needs. Narrow on purpose:
 *  it keeps the adapter testable with a four-method stub and documents that
 *  nothing else about xterm leaks into the input plane. */
export type TerminalLike = Pick<
  UseLiveTermResult,
  'send' | 'sendKey' | 'focus' | 'blur'
>

/** Either the handle itself, or a GETTER for it — which is how the three parent
 *  surfaces pass their `React.useRef<UseLiveTermResult | null>`:
 *  `terminalSessionInput(() => termRef.current)`. The getter is what lets a
 *  parent build the handle ONCE, before the terminal has mounted, and keep it
 *  stable across remounts; resolution happens per call, never during render
 *  (`react-hooks/refs`). */
export type TerminalSource =
  | TerminalLike
  | (() => TerminalLike | null | undefined)

/** `KeyName` (the REST allowlist) → the name/bytes `keyToBytes` understands.
 *
 *  The two vocabularies genuinely differ — tmux says `BTab`/`BSpace`/`C-c`,
 *  `keyToBytes` says `BackTab`/`Backspace`/`Ctrl-C` — and `keyToBytes` passes
 *  anything it does not recognise through as LITERAL TEXT. Without this table a
 *  `sendKey('BTab')` would type the four characters "BTab" into the prompt. The
 *  values that are not `keyToBytes` cases (`' '`, `y`, `n`, `q`) are literal on
 *  purpose: those keys ARE their character. */
export const TERMINAL_KEY_BYTES: Record<KeyName, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  BTab: 'BackTab', // CSI Z
  Space: ' ',
  BSpace: 'Backspace', // \x7f
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  'C-c': 'Ctrl-C',
  'C-d': 'Ctrl-D',
  'C-l': 'Ctrl-L',
  'C-r': 'Ctrl-R',
  'C-u': 'Ctrl-U',
  y: 'y',
  n: 'n',
  q: 'q',
}

// DELIVERY HONESTY — read before building on the returned promise.
//
// This plane's promises resolve as soon as the bytes are handed to the WS; they
// resolve EVEN WHEN THE WRITE WAS DROPPED (no terminal mounted yet, or the
// handle is a readOnly embed without `allowProgrammaticInput` — `use-live-term`
// returns early in both cases). That is deliberate and unchanged from the call
// sites this replaced, which were `termRef.current?.send(…)`: a fire-and-forget
// keystroke into an xterm that may not be there. So a resolved promise here is
// NOT a delivery receipt.
//
// Consequence for T4: `restSessionInput` rejects on a failed POST and the
// watchdog can flip that send to `undelivered` immediately, but on THIS plane
// only the inverted detection (no echo + no Active transition within
// WATCHDOG_MS) can catch a dropped write. Never special-case a resolved
// `submit()` into "confirmed".
export function terminalSessionInput(source: TerminalSource): SessionInput {
  const term = (): TerminalLike | null | undefined =>
    typeof source === 'function' ? source() : source

  return {
    // The ONE place a submit CR is appended in the app.
    submit: (text: string) => {
      term()?.send(`${text}\r`)
      return Promise.resolve()
    },
    insert: (text: string) => {
      term()?.send(text)
      return Promise.resolve()
    },
    sendKey: (key: KeyName) => {
      term()?.sendKey(TERMINAL_KEY_BYTES[key])
      return Promise.resolve()
    },
    focus: () => term()?.focus(),
    blur: () => term()?.blur(),
  }
}
