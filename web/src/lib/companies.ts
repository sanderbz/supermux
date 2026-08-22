// Companies (Bot Mode, migration 0030) — the client-side domain type + the two
// PURE helpers the switcher and the whole-app scoping lean on. Kept free of any
// `window` / fetch import so they unit-test in bun without a DOM.
//
// A `Company` is a first-class named workspace that owns a folder (`root_dir`)
// and a set of agents (sessions whose `company_id` points here). A session with
// `company_id == null` is a main/PA bot — omniscient, shown in every "All" view.

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
 *  another install) falls back to `null` = the "All" scope. Pure so the guard is
 *  unit-tested, and reused by the overview's reconcile effect. `null` in ⇒ `null`
 *  out (already "All"). */
export function resolveActiveCompany(
  active: number | null,
  liveIds: readonly number[],
): number | null {
  if (active === null) return null
  return liveIds.includes(active) ? active : null
}

/** Stable "company-first" ordering for GLOBAL search results (§4c): sessions
 *  belonging to `activeCompany` keep their incoming relative order but sort
 *  ahead of every cross-company match, which stays visible below. A no-op (a
 *  plain copy) when `activeCompany` is `null` — the "All" scope ranks nothing.
 *  Generic over anything carrying a nullable `company_id`. */
export function companyFirstOrder<T extends { company_id?: number | null }>(
  items: readonly T[],
  activeCompany: number | null,
): T[] {
  if (activeCompany === null) return [...items]
  const inCompany: T[] = []
  const others: T[] = []
  for (const it of items) {
    if (it.company_id === activeCompany) inCompany.push(it)
    else others.push(it)
  }
  return [...inCompany, ...others]
}
