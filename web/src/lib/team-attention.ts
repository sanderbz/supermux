/**
 * A team's DERIVED attention tier — the pure helper behind OD-2 (fold).
 * ─────────────────────────────────────────────────────────────────────────────
 * The old grok roster gave teams their own leading `Teams` divider, which meant
 * two orderings on one list and two different notions of "needs you" (R7/R8). The
 * owner decision is FOLD: a team is just another row that sorts into
 * `Needs you` / `Active` / `Done today` / `Idle` by its OWN derived attention,
 * exactly like a bot row does.
 *
 * This module is the arithmetic for that — pure, no React, no clock, no storage —
 * so the truth table is unit-testable without a DOM (`team-attention.test.ts`),
 * and the roster just buckets and renders. It also owns the two COUNT formulas
 * the header reads, for the same reason: the header can never disagree with the
 * sections if both are computed from the same pure functions.
 */
import type { ApiSession } from '@/lib/api'
import type { Team } from '@/lib/api/teams'
import { needsYouCount, taskProgress } from '@/lib/api/teams'

/** The four attention-ordered sections — the same keys `grok-roster` buckets
 *  sessions into, so a team row drops straight in beside the bots. */
export type GroupKey = 'needs' | 'active' | 'done' | 'idle'

/** The lead's contribution to its team's tier, reduced to the two bits that
 *  matter: does the lead itself need you, and is it actively working. `null` when
 *  the team has no live lead this tick (an unmapped lead adds no signal — the
 *  crew's own members decide the tier). */
export interface LeadSignal {
  needs: boolean
  active: boolean
}

/**
 * A team's derived attention tier.
 *
 *   needs  — a member is `needs_you`, OR the lead itself needs you.
 *   active — a member is `working`, OR the lead is active.
 *   done   — every task is completed (and, since `working` already returned
 *            `active`, no member is working).
 *   idle   — otherwise (calm, or no tasks at all).
 *
 * `needs` outranks `active` outranks `done`: a crew that needs you is a needs-you
 * row whatever else is true of it, which is exactly what R7/R8 said was broken.
 */
export function teamTier(t: Team, lead: LeadSignal | null): GroupKey {
  const working = t.members.some((m) => m.status === 'working')
  if (needsYouCount(t) > 0 || lead?.needs) return 'needs'
  if (working || lead?.active) return 'active'
  const { done, total } = taskProgress(t)
  if (total > 0 && done === total) return 'done'
  return 'idle'
}

/** Teams that actually have a crew. A rosterless team (0 members) is never
 *  rendered (6b: `TeamRow` returns null) and must never be counted, or the header
 *  would count a row nobody can see. This is the ONE filter both the counts and
 *  the section buckets pass through. */
export function rosteredTeams(teams: readonly Team[]): Team[] {
  return teams.filter((t) => t.members.length > 0)
}

/**
 * The header's "N bots": every standalone session, plus each rostered team's
 * MEMBERS and its lead.
 *
 * The lead is added back exactly once (`+1` when mapped) because `splitTeamLeads`
 * has already pulled the lead OUT of `sessions` — so a lead is never double
 * counted, and a team with an unmapped lead contributes only its members.
 */
export function totalBotCount(sessionCount: number, teams: readonly Team[]): number {
  return rosteredTeams(teams).reduce(
    (n, t) => n + t.members.length + (t.lead_supermux_session ? 1 : 0),
    sessionCount,
  )
}

/** Bucket the rostered teams into the four sections by their derived tier.
 *  `leadOf` resolves each team's `LeadSignal` (the roster reads it off the live
 *  sessions snapshot + the attention rollup); a bench passes `() => null`. */
export function groupTeamsByTier(
  teams: readonly Team[],
  leadOf: (t: Team) => LeadSignal | null,
): Record<GroupKey, Team[]> {
  const buckets: Record<GroupKey, Team[]> = { needs: [], active: [], done: [], idle: [] }
  for (const t of rosteredTeams(teams)) {
    buckets[teamTier(t, leadOf(t))].push(t)
  }
  return buckets
}

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

/** Bucket the sorted BOT roster into the same four attention-ordered sections
 *  team rows fold into. A plain module function so the `Date.now()` default lives
 *  OUTSIDE component render (the shape `attention-tiers.ts` uses) — a `Date.now()`
 *  in a `useMemo` body reads as an impurity to `react-hooks/purity`, and rightly
 *  so. Lives here (not in the roster component) so it is testable without the
 *  component's module graph, and so the roster file exports only components. */
export function groupSessions(
  sorted: readonly ApiSession[],
  needNames: ReadonlySet<string>,
  now: number = Date.now(),
): Record<GroupKey, ApiSession[]> {
  const buckets: Record<GroupKey, ApiSession[]> = { needs: [], active: [], done: [], idle: [] }
  for (const s of sorted) {
    if (needNames.has(s.name)) {
      buckets.needs.push(s)
      continue
    }
    if (s.status === 'active' || s.status === 'starting') {
      buckets.active.push(s)
      continue
    }
    // A background workflow is provably running even though the main agent
    // returned to its prompt: bucket it ACTIVE, never done/idle. This is the
    // frontend half of the `subagents_live` signal — the server holds an Active
    // turn while subagents churn, and here a left-open workflow whose server
    // status has already settled still reads as working.
    if (s.subagents_live) {
      buckets.active.push(s)
      continue
    }
    const t = s.updated_at ? Date.parse(s.updated_at) : NaN
    if (s.status === 'idle' && !Number.isNaN(t) && isSameDay(t, now)) {
      buckets.done.push(s)
      continue
    }
    buckets.idle.push(s)
  }
  return buckets
}
