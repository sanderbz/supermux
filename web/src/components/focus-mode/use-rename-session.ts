// useRenameSession (feat-session-info) — the inline "edit title" flow.
//
// A session's slug IS its displayed title (the backend never sends a separate
// task_summary), so renaming the slug is the edit-title op. Calls
// `PATCH .../config { rename }`; the server also renames the LIVE tmux session +
// rebuilds the pty stream, so a running terminal survives the rename. On success
// it invalidates the sessions list and resolves to the new name, so the caller
// navigates to `/focus/{new}` (the name is the identity everywhere — URL / tiles
// / board). Surfaces 409 (name taken) / 400 (invalid slug) as typed
// `SessionError`s for the caller to toast. Double-submits are guarded.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { sessionsApi } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

/** Sanitise free-typed text into a valid session slug (`[A-Za-z0-9_.-]+`, ≤100):
 *  whitespace runs collapse to a single `-`, everything else outside the set is
 *  dropped. Mirrors the server's `valid_name` charset so the UI never offers a
 *  target the server will 400. */
export function toSlug(raw: string): string {
  return raw
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 100)
}

export interface UseRenameSessionResult {
  pending: boolean
  /** Rename `name` → `target`. Resolves to the new name (from the server row).
   *  Rejects with a `SessionError` (status 409/400) on a rejected target. */
  run: (name: string, target: string) => Promise<string>
}

export function useRenameSession(): UseRenameSessionResult {
  const qc = useQueryClient()
  const [pending, setPending] = React.useState(false)

  const run = React.useCallback(
    async (name: string, target: string): Promise<string> => {
      if (pending) throw new Error('A rename is already in progress.')
      setPending(true)
      try {
        const row = await sessionsApi.rename(name, target)
        // Surface the renamed row in every cached list immediately (the SSE
        // `sessions` delta confirms it too, but don't wait on the round-trip).
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        return row?.name || target
      } finally {
        setPending(false)
      }
    },
    [pending, qc],
  )

  return { pending, run }
}
