// Last-active session — one shared cell across the app.
//
// Originally a "last-used session in the board composer" cell (that's why the
// file + persist key still carry the `board-create`
// name). Now widened: it's the session the user was last on, written by every
// surface that scopes to one session and read as the default for the Files page
// (so /files lands in the dir of the session you just dogfooded instead of
// $HOME) plus the original composer default.
//
// Writers:
//   • board composer — on every successful card create (defaults the next
//     card to the same session, previous behaviour).
//   • board switcher — when the user picks a `session:<name>` board.
//   • files route    — when the user opens `/files/:name`.
//   • focus route    — on mount of `/focus/:name`.
//
// Readers:
//   • board composer — defaults the session picker (chain: board scope ▶ this ▶ '').
//   • files route    — falls back from `:name` ▶ this ▶ $HOME for the listing root.
//
// Persistence: Zustand + `persist` → localStorage. Storage key kept as the
// historical `supermux:board-create-last-session` so existing user state is
// retained (Zustand `persist` is key-addressed; renaming the key wipes the
// value for every user). The filename + persist key are deliberately *not*
// renamed for the same reason — surface name is the hook (`useLastActiveSession`).

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LastActiveSessionState {
  /** The last-active session name. `null` = nothing remembered yet (callers
   *  fall back to their own default — Home for Files, "(no session)" for the
   *  composer). Empty-string `''` is a valid value meaning "no session" was
   *  explicitly chosen last time the composer ran. */
  lastSession: string | null
  setLastSession: (session: string | null) => void
}

export const useLastActiveSessionStore = create<LastActiveSessionState>()(
  persist(
    (set) => ({
      lastSession: null,
      setLastSession: (session) => set({ lastSession: session }),
    }),
    { name: 'supermux:board-create-last-session' },
  ),
)

/** Read the last-active session + a setter. Thin selector hook so consumers
 *  subscribe only to the cell they care about. */
export function useLastActiveSession(): [
  string | null,
  (session: string | null) => void,
] {
  const last = useLastActiveSessionStore((s) => s.lastSession)
  const setLast = useLastActiveSessionStore((s) => s.setLastSession)
  return [last, setLast]
}
