// useRenameSession (feat-session-info) — the inline "edit title" flow.
//
// "Rename" edits the session's mutable DISPLAY LABEL (migration 0019), NOT its
// slug. The slug `name` is the immutable identity (URL / tiles / board / tmux /
// $SUPERMUX_SESSION / hook token); keeping it fixed is what stops a running
// pane's hooks from going stale. So this calls `PATCH .../config { display_name }`
// and the caller does NOT navigate — the route is unchanged. It invalidates the
// sessions list so the new label shows immediately. Double-submits are guarded.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { sessionsApi } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

/** Trim a free-typed display label, bounded to 100 chars. The label is free-form
 *  (spaces, mixed case, etc. all allowed) — unlike the slug it never has to be a
 *  `[A-Za-z0-9_.-]` token, because it is never used as an identity/key. */
export function cleanDisplayName(raw: string): string {
  return raw.trim().slice(0, 100)
}

export interface UseRenameSessionResult {
  pending: boolean
  /** Set `name`'s display label to `label`. Resolves to the effective label
   *  (the server coalesces an empty label back to the slug). */
  run: (name: string, label: string) => Promise<string>
}

export function useRenameSession(): UseRenameSessionResult {
  const qc = useQueryClient()
  const [pending, setPending] = React.useState(false)

  const run = React.useCallback(
    async (name: string, label: string): Promise<string> => {
      if (pending) throw new Error('A rename is already in progress.')
      setPending(true)
      try {
        const row = await sessionsApi.setDisplayName(name, label)
        // The config PATCH emits no SSE, so the refetch this triggers is what
        // propagates the new label to the overview + every other surface.
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        return row?.display_name || label
      } finally {
        setPending(false)
      }
    },
    [pending, qc],
  )

  return { pending, run }
}
