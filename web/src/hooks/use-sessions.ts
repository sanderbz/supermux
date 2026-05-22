// useSessions — HARD-BLOCKER STUB (TECH_PLAN §M10, dep-graph fix).
//
// M12 fills this in: a TanStack Query against `/api/sessions` whose cache is
// invalidated by the SSE `sessions` delta (see use-sse.ts) — never polled.
// Mutations (create/start/stop/delete) call `api.*` and optimistically update.
//
// The typed shape here is the stable contract M11's tiles, the overview route,
// and the focus route all compile against.

import type { SessionSummary } from '@/lib/api'

export interface UseSessionsResult {
  sessions: SessionSummary[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  /** Force a refetch (no-op in the stub). */
  refetch: () => void
}

/**
 * STUB: returns an empty session list + no-op handlers. Real query + SSE
 * invalidation lands in M12.
 */
export function useSessions(): UseSessionsResult {
  return {
    sessions: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }
}

export interface UseSessionResult {
  session: SessionSummary | null
  isLoading: boolean
  isError: boolean
  error: Error | null
}

/**
 * STUB: single-session selector used by the focus route. Real implementation
 * (derive from the sessions query / dedicated fetch) lands in M12.
 */
export function useSession(_name: string): UseSessionResult {
  return { session: null, isLoading: false, isError: false, error: null }
}
