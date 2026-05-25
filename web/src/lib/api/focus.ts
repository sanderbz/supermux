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

  /** POST `/api/sessions/:name/start` — boot tmux + (re)launch the agent. The
   *  server's launch builder resumes the SAME conversation when the session has a
   *  `cc_conversation_id`, so this cleanly relaunches the session in place. The
   *  status SSE delta flips the tile to `starting`/`active` and the live terminal
   *  reconnects on its own (no manual refresh). Body is `{}` (no initial prompt). */
  startSession: (name: string): Promise<void> =>
    settingsRequest(`/api/sessions/${encodeURIComponent(name)}/start`, {
      method: 'POST',
      body: '{}',
    }),

  /** Restart = graceful stop, then start. The mobile focus control bar uses this
   *  to relaunch a session without leaving the focus view: the WS close on stop
   *  drops the live terminal to its `stopped` surface, and the start flips it back
   *  to running so the terminal reconnects to the fresh pty (same session, same
   *  conversation). Serialised (stop awaited before start) so the new tmux session
   *  is never spawned while the old teardown is still mid-flight. */
  restartSession: async (name: string): Promise<void> => {
    await focusApi.stopSession(name)
    await focusApi.startSession(name)
  },
}
