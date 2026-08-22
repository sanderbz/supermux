/**
 * Session status → mark state. The one mapping table.
 * ─────────────────────────────────────────────────────────────────────────────
 * B0 shipped six eye geometries and proved they are separable in a still frame.
 * What it never shipped is the sentence that connects them to the product: which
 * `SessionStatus` wears which face. Without it every surface invents its own,
 * and the mark stops being a status channel.
 *
 * ── Mind the enum drift ─────────────────────────────────────────────────────
 * The two enums are NOT the same set, and this mapping is written against the
 * TypeScript one on purpose:
 *
 *   Rust  `Status` (server/src/sessions/status.rs)
 *         Active | Waiting | Idle | Stopped | Starting | Unknown   ← no Error
 *   TS    `SessionStatus` (lib/api/sessions.ts)
 *         starting | active | idle | waiting | stopped | error     ← no unknown
 *
 * Errors do not ride the status field at all: they arrive as the separate
 * `error: {type, message}` delta key (a `StopFailure` hook), and the TS union
 * carries an `error` member the server never actually sends as a status. So the
 * mapping covers `error` (cheap, and the union demands totality) AND the surface
 * that draws the face has to consult `session.error` in its own right. The
 * attention tiers (T5) do exactly that — `needs` reads the FIELD, never a
 * status.
 *
 * `unknown` has no TS member, so there is nothing to map; if it ever gains one,
 * `MARK_STATE_FOR` stops compiling, which is the point of writing it as a total
 * `Record`.
 */
import type { MarkState } from '@/brand/marks'
import type { SessionStatus } from '@/lib/api/sessions'

/**
 * The table. Total by construction — a `Record<SessionStatus, MarkState>` fails
 * to compile the day a status is added and nobody decides what its face does.
 *
 * The three judgement calls, stated:
 *   · `starting` → `working`. The boot window is the agent being busy. The
 *     status DOT renders it neutral grey precisely because a dot cannot say
 *     "busy but not yet productive"; a face can — the eyes narrow and the
 *     breathe loop runs, which is honest for a session that is coming up.
 *   · `idle` → `idle`. The calm "turn ended, agent alive" state, and the only
 *     one where the eyes are simply open.
 *   · `error` → `failed`, the one mirrored tilt. Deliberately NOT `stopped`:
 *     "fell over" and "asleep" are the two states a user must never confuse,
 *     which is exactly why B0 drew them as separate geometries.
 */
export const MARK_STATE_FOR: Readonly<Record<SessionStatus, MarkState>> = {
  starting: 'working',
  active: 'working',
  idle: 'idle',
  waiting: 'waiting',
  stopped: 'stopped',
  error: 'failed',
}

/**
 * The Grok-skin refinement of `starting`: `connecting`, not `working`. A booting
 * session is coming online but not yet productive — the honest face is the
 * looking-around scan, not the heads-down concentration `working` implies. This
 * lives OUTSIDE `MARK_STATE_FOR` (which stays the byte-identical base table the
 * totality test pins) and is applied only by `markStateForSession`.
 */
const GROK_STATE_FOR: Partial<Record<SessionStatus, MarkState>> = {
  starting: 'connecting',
}

/**
 * Status → face, tolerant at the edge.
 *
 * The wire is JSON, so a client can be handed a status string a future server
 * invented. An unknown status renders `idle` rather than nothing: a row with no
 * face is broken, and "calm" is the safest lie for a state we cannot read.
 */
export function markStateFor(status: SessionStatus | string | undefined): MarkState {
  if (!status) return 'idle'
  return MARK_STATE_FOR[status as SessionStatus] ?? 'idle'
}

/**
 * The `done` face has no status of its own — it is a *moment*, not a state (a
 * turn that just finished cleanly), and the shipped `SessionStatus` union has no
 * member for it. Named here so the absence is documented rather than looking
 * like an oversight: the mark states are six, the statuses are six, and they are
 * not the same six.
 */
export const MARK_STATE_WITHOUT_STATUS: MarkState = 'done'

/* ── the Grok skin: richer state + a decoupled attention signal ─────────────────
 * The base app renders the six `markStateFor` faces and MUST stay byte-identical,
 * so nothing above changes. The Grok skin wants three more *moments* and an
 * attention layer that is orthogonal to the status word. Both live here so there
 * is still exactly ONE face-mapping module; both are consumed only by Grok-gated
 * render sites, so the base app never sees them.
 */

/** The transient attention tier — read from the FIELDS, never the status string
 *  (the audit's decoupling: a waiting session, an errored one and a
 *  permission-blocked one are three different attention reads). */
export type AttentionTier = 'needs' | 'blocked' | null

/** The subset of a session the attention read consults. Structural on purpose —
 *  any of `SessionSummary` / `SessionDetail` satisfies it. */
export interface AttentionInput {
  status?: SessionStatus | string
  error?: { type: string; message: string } | null
  permission_request?: unknown | null
  elicitation?: unknown | null
  blocked?: unknown | null
  /** A background workflow is provably running right now (server `subagents_live`).
   *  Draws the `working` face even after the main turn's status has settled. */
  subagents_live?: boolean | null
}

/**
 * The attention tier for a session.
 *
 *   `blocked` — it cannot proceed without you: it fell over (`error`), a
 *               permission dialog is open (`permission_request`), an MCP
 *               elicitation is pending (`elicitation`), or the server flagged it
 *               `blocked`. A STEADY red halo.
 *   `needs`   — it finished its turn and is waiting on your call (`waiting`). A
 *               PULSING red halo — a demand, not an emergency.
 *   `null`    — nothing wants you; the mark carries only its state.
 *
 * `blocked` outranks `needs` (an open dialog is louder than a finished turn).
 */
export function attentionFor(s: AttentionInput | null | undefined): AttentionTier {
  if (!s) return null
  if (s.error || s.blocked || s.permission_request || s.elicitation) return 'blocked'
  if (s.status === 'waiting') return 'needs'
  return null
}

/** The calm ` · N subagents` parallelism clause, shared by the chat WorkingRow
 *  and the Grok roster's state word so the two never drift. Empty below 2 — one
 *  subagent is not "parallel", and the clause is a parallelism tell, not a count. */
export function subagentsClause(subagents: number | undefined | null): string {
  return subagents && subagents >= 2 ? ` · ${subagents} subagents` : ''
}

/** Live hints a caller may know that the status field cannot spell. */
export interface SessionFaceHints {
  /** An assistant text delta is streaming to the transcript right now. */
  streaming?: boolean
  /** A reasoning/thinking delta is in flight (pre-output). */
  thinking?: boolean
  /** This mark is showing a just-finished turn (the `done` moment). */
  done?: boolean
}

/**
 * Status (+ optional live hints) → face, the Grok-skin resolver.
 *
 * The precedence, most-specific first:
 *   1. `done`      — a just-finished turn (a moment the status field cannot spell).
 *   2. `streaming` — an assistant text delta is landing right now: the face talks.
 *   3. `thinking`  — a reasoning delta is in flight before any output.
 *   4. the Grok state map — `starting → connecting` (honest booting face).
 *   5. the base `markStateFor` table (the six shipped faces).
 *
 * A base roster (which never passes hints and reads `markStateFor` directly) and
 * a Grok roster agree on every non-moment status; the moments are additive.
 */
export function markStateForSession(
  s: AttentionInput | null | undefined,
  hints: SessionFaceHints = {},
): MarkState {
  if (hints.done) return MARK_STATE_WITHOUT_STATUS
  if (hints.streaming) return 'streaming'
  if (hints.thinking) return 'thinking'
  // A live background workflow reads WORKING even once the main turn's status has
  // settled to idle — the face half of `subagents_live` (the row is bucketed
  // active by `groupSessions`, so it never wears the `done` moment above).
  if (s?.subagents_live) return 'working'
  const status = s?.status as SessionStatus | undefined
  if (status && GROK_STATE_FOR[status]) return GROK_STATE_FOR[status]!
  return markStateFor(s?.status)
}
