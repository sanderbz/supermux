// Companies (Bot Mode, migration 0032) — the client-side domain type + the two
// PURE helpers the switcher and the whole-app scoping lean on. Kept free of any
// `window` / fetch import so they unit-test in bun without a DOM.
//
// A `Company` is a first-class named workspace that owns a folder (`root_dir`)
// and a set of agents (sessions whose `company_id` points here). A session with
// `company_id == null` is a main/PA bot — it lives in HQ, the default landing
// space (`activeCompany === null`). There is NO view that mixes HQ with a
// company: HQ shows only main bots, a company shows only its own.

/** One company row. Mirrors the server `db::companies::Company` wire shape
 *  (`server/src/db/companies.rs`); `created_at`/`updated_at` ride along but the
 *  UI only reads `{id, slug, display_name, root_dir, archived}`. `archived` is
 *  the server's `0 | 1` integer, not a boolean. */
export interface Company {
  id: number
  slug: string
  display_name: string
  root_dir: string
  archived: number
  created_at?: number
  updated_at?: number
}

/** Resolve a persisted `activeCompany` id against the live company set: an id
 *  that no longer maps to a company (deleted, or a stale localStorage value from
 *  another install) falls back to `null` = HQ (the main/PA space). Pure so the
 *  guard is unit-tested, and reused by the overview's reconcile effect. `null`
 *  in ⇒ `null` out (already HQ). */
export function resolveActiveCompany(
  active: number | null,
  liveIds: readonly number[],
): number | null {
  if (active === null) return null
  return liveIds.includes(active) ? active : null
}

/** Whether a session/team carrying `companyId` belongs in the current BROWSE
 *  scope (no search active). HQ (`activeCompany === null`) shows ONLY main bots
 *  (`company_id` null/undefined); a company shows only its own. There is no
 *  mixed view. A non-empty search LIFTS this scope, so callers gate on the query
 *  BEFORE consulting this. Pure + unit-tested; reused by the overview filter. */
export function inCompanyScope(
  companyId: number | null | undefined,
  activeCompany: number | null,
): boolean {
  if (activeCompany === null) return companyId == null
  return companyId === activeCompany
}

/** The STARTING root the Files browser opens at for the active space. A company
 *  (`activeCompany !== null`) roots the browser at its `root_dir`; HQ
 *  (`activeCompany === null`) returns `null` = unrestricted (the owner sees
 *  everything, current behavior). A stale `activeCompany` id that no longer maps
 *  to a live company also returns `null` — the same fail-open-to-HQ rule
 *  `resolveActiveCompany` keeps. Pure + unit-tested; the route applies it as the
 *  starting cwd only, so manual navigation (`?path=`, a session pick) still
 *  wins. */
export function companyFilesRoot(
  activeCompany: number | null,
  companies: readonly Company[],
): string | null {
  if (activeCompany === null) return null
  const c = companies.find((c) => c.id === activeCompany)
  return c ? c.root_dir : null
}

/** CONFINE a requested Files path to the active company's root — the owner-lens
 *  clamp that keeps the browser inside `companyFilesRoot` once a company is
 *  selected. `companyRoot === null` (HQ, or a stale id that failed open) never
 *  clamps: the path passes through untouched, so HQ browsing is byte-identical to
 *  before. With a root set, a path AT or BELOW the root is returned unchanged
 *  (free navigation within the company); anything ELSE — a parent, an unrelated
 *  absolute, `~`, `/`, or a name-prefix sibling like `…/acme-corp` for `…/acme` —
 *  clamps back to the root. Boundary is `/`-delimited so a shared name prefix is
 *  NOT mistaken for containment. This is an interface lens, NOT the security
 *  boundary (the server-side member files-jail is separate and unchanged). Pure +
 *  unit-tested. */
export function confineToCompanyRoot(
  path: string,
  companyRoot: string | null,
): string {
  if (companyRoot === null) return path
  const rootNorm = stripTrailingSlash(companyRoot)
  const pathNorm = stripTrailingSlash(path)
  if (pathNorm === rootNorm) return path
  if (pathNorm.startsWith(rootNorm + '/')) return path
  return companyRoot
}

function stripTrailingSlash(p: string): string {
  // Collapse a trailing slash (but never the lone filesystem root `/`).
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Which companies (by id; `null` = HQ) have at least one bot in the NEEDS-YOU
 *  state — the set the switcher's per-company attention dots read.
 *
 *  It is computed from the FULL, unfiltered session list on purpose: the scoped
 *  header census intentionally drops cross-company counts, so this is how the
 *  switcher keeps the awareness that "Globex needs you" while you are browsing
 *  Acme. The needs-you rule is INJECTED (`needsYou`), never re-invented here —
 *  the caller passes the roster's OWN predicate (`(name) => needNames.has(name)`,
 *  the app-wide attention rollup that the NEEDS YOU section and the header count
 *  already read) so there is exactly one definition of "needs you" in the app.
 *  Generic over anything carrying a `name` + nullable `company_id`; a
 *  null/undefined `company_id` folds to the `null` (HQ) key. Pure + unit-tested. */
export function companiesNeedingAttention<
  T extends { name: string; company_id?: number | null },
>(sessions: readonly T[], needsYou: (name: string) => boolean): Set<number | null> {
  const out = new Set<number | null>()
  for (const s of sessions) {
    if (needsYou(s.name)) out.add(s.company_id ?? null)
  }
  return out
}

/** The company the ⌘/Ctrl+1..9 power-user shortcut jumps to: `digit` is 1-based
 *  (the key the user pressed), so it selects `companies[digit - 1]`. Out-of-range
 *  digits (no Nth company) resolve to `undefined` = no-op, so the switcher never
 *  jumps to a company that isn't there. Pure + unit-tested. The `Company | null`
 *  return is the *scope value* (`.id`) the caller writes; this helper hands back
 *  the row so the caller can read its id and name. */
export function companyForDigit(
  companies: readonly Company[],
  digit: number,
): Company | undefined {
  if (!Number.isInteger(digit) || digit < 1) return undefined
  return companies[digit - 1]
}

/** Stable "space-first" ordering for GLOBAL search results: sessions in the
 *  ACTIVE space keep their incoming relative order but sort ahead of every
 *  out-of-space match, which stays visible below. The active space is HQ when
 *  `activeCompany === null` (main bots, `company_id` null/undefined, rise first)
 *  or a company otherwise. Generic over anything carrying a nullable
 *  `company_id`; `null` is the HQ key so ranking works in HQ too. */
export function companyFirstOrder<T extends { company_id?: number | null }>(
  items: readonly T[],
  activeCompany: number | null,
): T[] {
  const inSpace: T[] = []
  const others: T[] = []
  for (const it of items) {
    if ((it.company_id ?? null) === activeCompany) inSpace.push(it)
    else others.push(it)
  }
  return [...inSpace, ...others]
}
