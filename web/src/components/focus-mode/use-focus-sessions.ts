// useFocusSessions — M14.
//
// SINGLE SOURCE OF TRUTH (PRINCIPLE critic): the desktop focus session-strip
// reads the SAME `useSessions()` store the overview tile grid reads — there is
// NO second fetch and NO per-session polling for the strip. The compact tiles
// and their peek-popovers render the very `preview_lines` the tile grid renders
// (both consume `TileSession`). When M12 wires `useSessions()` to the SSE-driven
// TanStack cache, this strip updates live for free.
//
// Returns the ordered list plus the current session resolved from the route
// `:name`, so the keyboard-capture layer can map Cmd+1..9 to the N-th row.

import * as React from 'react'

import { useSessions } from '@/hooks/use-sessions'
import type { TileSession } from '@/components/session-tile/types'

export interface FocusSessionsResult {
  /** Ordered strip rows — the canonical session list (single source). */
  sessions: TileSession[]
  /** The focused row resolved from the route name (null while loading/unknown). */
  current: TileSession | null
  isLoading: boolean
}

/**
 * @param name      The focused session name (route param).
 * @param override  DEV-only injection (the /dev/focus verification page passes
 *                  mock sessions so the desktop layout is reviewable without a
 *                  live backend). Production callers omit it → real store.
 */
export function useFocusSessions(
  name: string,
  override?: TileSession[],
): FocusSessionsResult {
  const { sessions: live, isLoading } = useSessions()

  const sessions = override ?? live

  const current = React.useMemo(
    () => sessions.find((s) => s.name === name) ?? null,
    [sessions, name],
  )

  return { sessions, current, isLoading: override ? false : isLoading }
}
