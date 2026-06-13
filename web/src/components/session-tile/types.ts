import type { SessionSummary } from '@/lib/api'

/** Display fields the hero tile layers on top of the canonical `SessionSummary`.
 *  All optional, so a plain `SessionSummary` from
 *  `useSessions()` is already a valid `TileSession` — the SSE `sessions` payload
 *  populates these when present and the tile degrades gracefully
 *  (`task_summary` → `name`). Kept in this module rather than `lib/api.ts`
 *  so this addition can't conflict with sibling frontend modules. */
export interface TileSession extends SessionSummary {
  /** Claude Code chat description / auto-title. Falls back to `name`. */
  task_summary?: string
  /** Cumulative token count for the meta row (rendered as e.g. "12.3k"). */
  tokens?: number
  /** Git branch / worktree shown in the meta row. */
  branch?: string
  /** True when the underlying tmux session is gone → render `<TileError>`. */
  missing?: boolean
  /** Live "what the agent is doing now" label from the latest PreToolUse hook
   *  (hooks-10x) — e.g. "✎ tile.tsx" / "⚡ npm test". Present only while a tool
   *  is running; cleared on Stop/SessionEnd. Drives the calm activity line. */
  activity?: string
  /** Machine class for `activity` (`bash`/`edit`/`read`/`search`/`web`/`task`/
   *  `mcp`/`fail`). Present iff `activity` is. */
  activity_kind?: string
  /** Live count of outstanding Task sub-agents for the current turn. Display-only
   *  parallelism signal: the activity line gains a calm `· N subagents` clause
   *  when the agent is working and this is ≥ 2. Absent/0 → no clause. */
  subagents?: number
  /** The latest unrecovered agent error from a StopFailure hook (hooks-10x).
   *  Cleared when the agent resumes — drives the amber error badge. */
  error?: { type: string; message: string }
  /** Remote host the session runs on. `null` /
   *  undefined = LOCAL — the historical default. The tile renders a small
   *  <HostBadge> when this is set. */
  host_id?: number | null
}
