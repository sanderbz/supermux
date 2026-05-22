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
import type { ApiSession } from '@/lib/api'
import type { TileSession } from '@/components/session-tile/types'

/** Coerce the wire shape to the tile's `TileSession` (the tile requires a string
 *  `updated_at`; the API leaves it optional for partial deltas). Mirrors the same
 *  boundary coercion the overview route applies to the shared `useSessions()`
 *  list — M12 returns `ApiSession`, the strip tiles consume `TileSession`. */
function toTileSession(s: ApiSession): TileSession {
  return { ...s, updated_at: s.updated_at ?? '' }
}

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

  const sessions = React.useMemo<TileSession[]>(
    () => override ?? live.map(toTileSession),
    [override, live],
  )

  const current = React.useMemo(
    () => sessions.find((s) => s.name === name) ?? null,
    [sessions, name],
  )

  return { sessions, current, isLoading: override ? false : isLoading }
}
