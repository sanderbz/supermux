// Where "manage all workflows" and "open the thread" go — one module, one place.
//
// PURE, and deliberately so: it is the only thing in the workflows subtree that
// may know a route, and the `bun test` runner resolves it without a React tree
// behind it. Its ONE import is `lib/agent-href`, which is pure for the same
// reason — better than a second copy of a route string here.
//
// The descendant of `session-schedules/schedule-href.ts`, whose whole reason
// for existing was that B1 folded `/scheduler` into Settings while the surfaces
// pointing at it were still being written. Workflows unfolds that: the route is
// a real top-level destination again, so the constant moves back — and it moves
// HERE rather than being inlined at four call sites, because that is what made
// the last move a one-line change instead of a grep.

import { agentHref } from '@/lib/agent-href'

/** The workflows list — the "manage all workflows" destination. */
export const WORKFLOWS_ROUTE = '/workflows'

/** The list. `folded` exists so both worlds stay reachable from a test if the
 *  surface is ever folded into Settings again. */
export function workflowAdminHref(folded: boolean = false): string {
  return folded ? '/settings#workflows' : WORKFLOWS_ROUTE
}

/** One workflow's detail (steps + run history). */
export function workflowHref(id: string): string {
  return `${WORKFLOWS_ROUTE}/${encodeURIComponent(id)}`
}

/** The composer, creating. `session` pre-selects the owning bot — what
 *  "+ New workflow" inside a bot's panel needs. */
export function workflowNewHref(session?: string | null, prompt?: string | null): string {
  const q = new URLSearchParams()
  if (session) q.set('session', session)
  // The chat composer's clock carries the draft the typist already wrote into
  // step 1 — the human path §13.3 calls trivial, and it stays trivial: no new
  // form, no new endpoint, just a seeded first step.
  if (prompt?.trim()) q.set('prompt', prompt.trim())
  const s = q.toString()
  return s ? `${WORKFLOWS_ROUTE}/new?${s}` : `${WORKFLOWS_ROUTE}/new`
}

/** The composer, editing. */
export function workflowEditHref(id: string): string {
  return `${WORKFLOWS_ROUTE}/${encodeURIComponent(id)}/edit`
}

/**
 * "Open the thread here →" — the bot's own chat pane, which is where a workflow
 * actually happens. A run has no surface of its own to link to: the steps are
 * delivered into the bot's transcript like anything else a human typed, and
 * pretending otherwise would be the dishonest link.
 *
 * The thread is on HOME, so this is the home address (`lib/agent-href.ts`) —
 * not the terminal, which is not where a workflow's steps are read.
 */
export function botThreadHref(session: string): string {
  return agentHref(session)
}
