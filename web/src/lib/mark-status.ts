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
