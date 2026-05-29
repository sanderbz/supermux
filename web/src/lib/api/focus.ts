// Focus-mode session control.
//
// The desktop focus dock's Stop (⌘W) button needs a real `stopSession`; this is
// that real fetch.
//
// LIVE keystrokes are NOT sent through here — they flow over the WebSocket pty
// (the LiveTerminal). This block is HTTP control-plane only (stop). Envelope
// + bearer reuse the shared `settingsRequest` helper in ./client (token from
// window at call time — never embedded in source).

import { settingsRequest } from './client'

export const focusApi = {
  /** POST `/api/sessions/:name/stop` — stop the session (⌘W). The backend nudges
   *  the agent to exit, then TEARS THE TMUX SESSION DOWN promptly (it does NOT
   *  keep the pane) — so the session disappears from `tmux ls` quickly. The DB
   *  row stays as a `stopped`, resumable card by design (Archive clears it). The
   *  server broadcasts the `stopped` status over SSE on teardown, and callers
   *  optimistically flip the cached row so the overview reflects it instantly.
   *  Returns 202 (async-shaped) once the row is `stopped`. */
  stopSession: (name: string): Promise<void> =>
    settingsRequest(`/api/sessions/${encodeURIComponent(name)}/stop`, {
      method: 'POST',
    }),

  /** POST `/api/sessions/:name/start` — (re)launch a stopped session (resumes the
   *  same conversation when one exists). Pairs with `stopSession` for "restart". */
  startSession: (name: string): Promise<void> =>
    settingsRequest(`/api/sessions/${encodeURIComponent(name)}/start`, {
      method: 'POST',
    }),
}
