import type { SessionSummary } from '@/lib/api'
import type { ElicitationAsk } from '@/components/chat/elicitation'
import type { ChatTail, PermissionRequestInfo } from '@/lib/api/sessions'
import type { RateLimits } from '@/lib/rate-limits'

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
  /** Searchable tags (`SessionView.tags`). On the wire since forever with
   *  nothing rendering them; the fact ladder puts them on the list row at
   *  tier 4 and fase B2 T7 gives them an editor. */
  tags?: string[]
  /** Pinned-first ordering (`SessionView.pinned`). Read by `smartSort` and, in
   *  fase B2, by the pinned-block hairline. */
  pinned?: boolean
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
  /** Which terminal backend drives this session (migration 0024). Read by the
   *  recovery ladder (B5/T8): only a native, local session has a holder that
   *  can be recovered in place — a tmux pane has none, and the ladder says so
   *  rather than offering a button that can only answer "unsupported". */
  runtime?: string
  /** Live, undecided permission dialog for the current tool call. Rides the
   *  `sessions` SSE delta; `null` clears it (always optional-chain). */
  permission_request?: PermissionRequestInfo | null
  /** A third-party MCP server is demanding a typed form (`Elicitation` hook) and
   *  the session is parked on it. Same delta, same `null`-clears rule. */
  elicitation?: ElicitationAsk | null
  /** Server-clock ms stamp on the latest activity delta — the fase-A1
   *  hook→UI latency anchor. */
  activity_at?: number
  /** The session cannot do the next turn — a usage-limit banner or a startup
   *  gate on the live capture (server `sessions::pty_state`). A CONDITION, not a
   *  status: a limit-hit turn ends with an ordinary `Stop`, so `status` reads
   *  `idle` and the tile drew green while the account was cut off for five hours
   *  (verify matrix finding 1). */
  blocked?: {
    /** `limit` | `startup` | `paused` (`sessions::pty_state::Blocked`). */
    kind: string
    text: string
    detail?: string
    wedge?: string
    /** Which consent modal, for `kind: 'paused'` — `overage_consent` or
     *  `refusal_fallback` (catalog `limit.overage_consent_dialog` /
     *  `err.refusal_fallback_dialog`). The turn is not over and no hook will
     *  ever say so, which is why this arrives from the capture. */
    dialog?: string
  } | null
  /** The dim ≥70 % footer warning Claude Code prints, verbatim. A quiet chip. */
  limit_warning?: string | null
  /** Usage headroom from the opt-in statusline tap. Absent on every host without
   *  it, which is every host by default. */
  rate_limits?: RateLimits | null
  /** Chat one-liner pair (last prompt + last assistant line) from the session's
   *  chat ring — fase A2, carried on the `sessions` SSE delta. Absent means
   *  UNCHANGED, never "empty": a delta without the key must leave whatever the
   *  tile already shows in place. Its `ts` is Claude's own entry clock, so it
   *  must not be compared with `activity_at`. */
  chat_tail?: ChatTail
}
