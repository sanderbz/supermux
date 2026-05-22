import type { SessionSummary } from '@/lib/api'

/** Display fields the hero tile layers on top of the canonical `SessionSummary`
 *  (TECH_PLAN §4.3). All optional, so a plain `SessionSummary` from
 *  `useSessions()` is already a valid `TileSession` — the SSE `sessions` payload
 *  populates these when present and the tile degrades gracefully
 *  (`task_summary` → `name`). Kept in the M11 module rather than `lib/api.ts`
 *  so this addition can't conflict with sibling frontend milestones. */
export interface TileSession extends SessionSummary {
  /** Claude Code chat description / auto-title. Falls back to `name`. */
  task_summary?: string
  /** Cumulative token count for the meta row (rendered as e.g. "12.3k"). */
  tokens?: number
  /** Git branch / worktree shown in the meta row. */
  branch?: string
  /** True when the underlying tmux session is gone → render `<TileError>`. */
  missing?: boolean
}
