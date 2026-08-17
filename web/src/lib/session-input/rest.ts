// restSessionInput — the SessionInput implementation for surfaces that have no
// xterm mounted (the chat renderer).
//
// It writes through the three endpoints that already exist server-side, so A4
// needed no server work for the input plane:
//
//   submit  → POST /api/sessions/{name}/send   {text}
//             `lifecycle.rs send_text` appends the Enter ITSELF (plus the
//             provider submit gap — a TUI can need one or the Enter is
//             absorbed as part of the paste), stamps `last_send_at` and
//             broadcasts a delta. So the caller passes the RAW text: a trailing
//             '\r' here would be a second submit.
//   insert  → POST /api/sessions/{name}/paste  {text, submit:false}
//             bracketed paste; lands at the TUI's `❯` without submitting.
//   sendKey → POST /api/sessions/{name}/keys   {keys}
//             allowlist-enforced (see `KeyName`).
//
// `focus`/`blur` are delegated: the REST plane has no cursor of its own, so the
// owner passes the React composer's focus/blur in.

import { sessionRequest } from '../api/sessions'

import { inputRoutes } from './routes'
import type { KeyName, SessionInput } from './types'

/** The injectable transport. The default is the shared `sessionsApi` request
 *  (bearer auth, `{ok,data}` envelope, `SessionError` with its status), so a
 *  rejected POST is what the T4 watchdog sees as an undelivered send. Tests
 *  pass their own to observe the exact URL and body. */
export type RestRequest = (url: string, init?: RequestInit) => Promise<unknown>

const defaultRequest: RestRequest = (url, init) =>
  sessionRequest<unknown>(url, init)

export interface RestSessionInputOptions {
  request?: RestRequest
  /** Focus the React composer — the REST plane's "cursor". */
  onFocus?: () => void
  onBlur?: () => void
}

export function restSessionInput(
  name: string,
  opts: RestSessionInputOptions = {},
): SessionInput {
  const request: RestRequest = opts.request ?? defaultRequest
  const post = (url: string, body: unknown): Promise<void> =>
    request(url, { method: 'POST', body: JSON.stringify(body) }).then(
      () => undefined,
    )

  return {
    // Raw text. The server adds the Enter.
    submit: (text: string) => post(inputRoutes.send(name), { text }),
    insert: (text: string) =>
      post(inputRoutes.paste(name), { text, submit: false }),
    sendKey: (key: KeyName) => post(inputRoutes.keys(name), { keys: key }),
    focus: () => opts.onFocus?.(),
    blur: () => opts.onBlur?.(),
  }
}
