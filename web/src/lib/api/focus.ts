// M14 — Focus-mode session control.
//
// The desktop focus dock's Stop (⌘W) button needs a real `stopSession` before
// M12 wires the full sessions client; this is that real fetch.
//
// LIVE keystrokes are NOT sent through here — they flow over the M4 WebSocket pty
// (the M13 LiveTerminal). This block is HTTP control-plane only (stop). Envelope
// + bearer reuse the shared `settingsRequest` helper in ./client (token from
// window at call time — never embedded in source).

import { settingsRequest } from './client'

export const focusApi = {
  /** POST `/api/sessions/:name/stop` — stop the session (⌘W). Keeps the tmux
   *  pane per §3.4; the overview reflects it via the next SSE `sessions` delta. */
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
