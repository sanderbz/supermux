// The three WRITE routes of the input plane, in one place so `sessionsApi` and
// `restSessionInput` can never drift apart on a path.
//
// A LEAF module — zero imports — on purpose: `restSessionInput` has to be able
// to name a route without pulling in the API client, whose `@/env` accessors
// read `window` and so cannot load in a DOM-less unit test.

export const inputRoutes = {
  /** Text + submit. The server appends the Enter (`lifecycle.rs send_text`). */
  send: (name: string) => `/api/sessions/${encodeURIComponent(name)}/send`,
  /** Bracketed paste; `{submit:false}` inserts without sending. */
  paste: (name: string) => `/api/sessions/${encodeURIComponent(name)}/paste`,
  /** One named key, allowlist-checked server-side (`KEY_ALLOWLIST`). */
  keys: (name: string) => `/api/sessions/${encodeURIComponent(name)}/keys`,
}
