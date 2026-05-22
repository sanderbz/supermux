// useBoard — HARD-BLOCKER STUB (TECH_PLAN §M10, dep-graph fix).
//
// M19 fills this in: a TanStack Query against `/api/board` invalidated by the
// SSE `board` delta (see use-sse.ts) — never polled. Mutations cover create /
// patch / claim (atomic CAS, §3.2.10) / delete with optimistic updates.

import type { Issue } from '@/lib/api'

export interface UseBoardResult {
  issues: Issue[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  /** Force a refetch (no-op in the stub). */
  refetch: () => void
}

/**
 * STUB: returns an empty board + no-op handlers. Real query + SSE invalidation
 * lands in M19.
 */
export function useBoard(): UseBoardResult {
  return {
    issues: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  }
}
