// Last-used "create-task" session store (FEAT-BOARD-SESSION §B).
//
// The board's task composer surfaces a session picker as its prominent control
// (replacing the Claude/Shell provider toggle that moved into "More"). The
// default selection follows a small resolution chain:
//   1. Board scope wins: a per-session board (`session:<name>`) → that session;
//      a per-team board → that team's lead session.
//   2. Otherwise (Main / All / a team with no live lead): the value persisted
//      here, set on every successful create. Empty string = "(no session)" — an
//      explicit zero-attachment choice the user picked last.
//
// Mirrors the `team-density-store.ts` pattern: Zustand + the `persist`
// middleware → localStorage so the choice survives a browser restart, with one
// account-wide value (a per-board override would over-fit; the chain above gives
// per-board context already).
//
// The store is intentionally a TINY cell — no derived state, no SSE coupling —
// so the composer can read + write it without ceremony.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BoardCreateSessionState {
  /** The last successfully-used session for board-task create. `null` = nothing
   *  remembered yet (composer falls back to "(no session)"). Empty-string `''`
   *  is a valid value meaning "no session" was explicitly chosen last time. */
  lastSession: string | null
  setLastSession: (session: string | null) => void
}

export const useBoardCreateSessionStore = create<BoardCreateSessionState>()(
  persist(
    (set) => ({
      lastSession: null,
      setLastSession: (session) => set({ lastSession: session }),
    }),
    { name: 'supermux:board-create-last-session' },
  ),
)

/** Read the last-used session + a setter. Thin selector hook so the composer
 *  subscribes only to the cell it cares about. */
export function useLastCreateSession(): [
  string | null,
  (session: string | null) => void,
] {
  const last = useBoardCreateSessionStore((s) => s.lastSession)
  const setLast = useBoardCreateSessionStore((s) => s.setLastSession)
  return [last, setLast]
}
