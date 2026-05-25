// useCloneSession (feat-session-info) — the "clone agent in this directory" flow.
//
// Derives a fresh unique name (mirrors new-session-sheet.tsx's base36-suffix
// pattern), calls `sessionsApi.duplicate` (server copies dir / desc / provider /
// flags / tags / branch / worktree / mcp into a new row), boots it via
// `sessionsApi.start`, invalidates the sessions list so the new row appears, and
// resolves to the new name so the caller can navigate to `/focus/{name}`.
//
// On a 409 (the generated name already exists) it regenerates the suffix and
// retries ONCE. Double-clicks are guarded via the `pending` flag.

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { sessionsApi, SessionError } from '@/lib/api'
import { SESSIONS_KEY } from '@/hooks/use-sessions'

/** Short, URL/tmux-safe base36 suffix — same idea as new-session-sheet.tsx. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

/** Stem from the source name, stripping any existing `-xxxx` clone suffix so
 *  re-cloning a clone doesn't pile up suffixes. Falls back to the dir basename
 *  shape is unnecessary here — the source name is always present + valid. */
function stemOf(source: string): string {
  return source.replace(/-[a-z0-9]{4}$/i, '') || source
}

function freshName(source: string): string {
  return `${stemOf(source)}-${suffix()}`
}

export interface UseCloneSessionResult {
  pending: boolean
  /** Clone `source` into a fresh session in the SAME directory, boot it, and
   *  resolve to the new name. Rejects on a non-recoverable failure. */
  run: (source: string) => Promise<string>
}

export function useCloneSession(): UseCloneSessionResult {
  const qc = useQueryClient()
  const [pending, setPending] = React.useState(false)

  const run = React.useCallback(
    async (source: string): Promise<string> => {
      if (pending) throw new Error('A clone is already in progress.')
      setPending(true)
      try {
        let newName = freshName(source)
        try {
          await sessionsApi.duplicate(source, newName)
        } catch (e) {
          // 409 = the generated name collided — regenerate the suffix once.
          if (e instanceof SessionError && e.status === 409) {
            newName = freshName(source)
            await sessionsApi.duplicate(source, newName)
          } else {
            throw e
          }
        }
        // Boot the new session. Non-fatal if it fails — the row exists and can
        // be started from its focus route — but we still navigate either way.
        try {
          await sessionsApi.start(newName)
        } catch {
          /* row exists; start retryable from focus */
        }
        // Surface the new row in every cached list immediately.
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
        return newName
      } finally {
        setPending(false)
      }
    },
    [pending, qc],
  )

  return { pending, run }
}
