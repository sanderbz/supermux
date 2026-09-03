// THE ADDRESS OF A BOT — `/agent/<name>` — and what following one means.
//
// Home (the roster and its thread pane) is where you talk to a bot, but a thread
// opened there had no URL: nothing could link to it, so every "open this agent"
// link in the app — and every push notification — pointed at `/focus/<name>`,
// the full-screen TERMINAL. Following a link therefore landed you in the wrong
// surface, and a link to a bot living in another company landed you in the wrong
// SCOPE as well, staring at a roster that does not contain it.
//
// `/agent/:name` is that missing address. It renders the SAME home element as
// `/` (App.tsx), the roster consumes the name once and switches the company
// scope when the bot lives in one, then replaces the URL with `/` — so the
// address is a doorway, not a second surface with its own state to keep in sync.
// `/focus/<name>` stays exactly what it is: the explicit terminal escape hatch.
//
// PURE AND IMPORT-FREE, for the reasons `workflow-href.ts` spells out: the route
// string lives in ONE place, and `bun test` resolves this module with no React
// tree behind it.

/** Where "open this agent" goes. */
export function agentHref(name: string): string {
  return `/agent/${encodeURIComponent(name)}`
}

/** Is this pathname the address above? The shell asks (layout.tsx) so it can
 *  treat the doorway as home; keeping the answer here keeps the route string in
 *  one module. */
export function isAgentPath(pathname: string): boolean {
  return pathname.startsWith('/agent/')
}

/** The roster rows a deep link is resolved against — structural, so the resolver
 *  is testable without an `ApiSession` fixture. `company_id` absent or `null`
 *  means HQ, the same rule `inCompanyScope` uses. */
export interface AgentDeepLinkRow {
  name: string
  company_id?: number | null
}

/** What following `/agent/<name>` means, once the roster has actually loaded.
 *
 *  `switch` and `select` differ by ONE fact — whether the bot's company is the
 *  scope you are browsing — and the caller must act on that fact FIRST, because
 *  switching the scope re-homes the open pane (grok-roster's render-phase scope
 *  reconcile): selecting before switching would have the reconcile throw the
 *  selection away as out-of-scope. */
export type AgentDeepLink =
  | { kind: 'unknown'; name: string }
  | { kind: 'select'; name: string; company: number | null }
  | { kind: 'switch'; name: string; company: number | null }

/**
 * Resolve a deep-linked bot name against the live roster.
 *
 * Call this ONLY once the sessions query has resolved. An empty list that has
 * not landed yet is not an empty roster, and answering `unknown` against it is
 * how a perfectly live thread gets reported as deleted — the same mistake the
 * company-scope reconcile and the conversation restore each had to learn.
 */
export function resolveAgentDeepLink(
  name: string,
  sessions: readonly AgentDeepLinkRow[],
  activeCompany: number | null,
): AgentDeepLink {
  const row = sessions.find((s) => s.name === name)
  if (!row) return { kind: 'unknown', name }
  const company = row.company_id ?? null
  return {
    kind: company === activeCompany ? 'select' : 'switch',
    name: row.name,
    company,
  }
}
