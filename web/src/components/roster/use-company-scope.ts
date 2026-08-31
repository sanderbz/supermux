// `useCompanyScope()` — the ONE active-company hook every scoped surface reads
// (Companies, Bot Mode). It hands back the current `activeCompany` and a memoised
// `inScope(company_id)` predicate, so the store / workflows / browser surfaces
// filter exactly like the overview roster does without each re-deriving the rule.
//
// It also carries the roster's stale-id reconcile (`grok-roster.tsx`): a persisted
// `activeCompany` that no longer maps to a live company (deleted/archived, or a
// localStorage value from another install) falls back to HQ. Kept as an EFFECT off
// the live ids — the same shape the roster uses — so the guard runs the moment any
// scoped surface is the one mounted, not only the overview. The pure guard
// (`resolveActiveCompany`) and the scope rule (`inCompanyScope`) stay in
// `lib/companies.ts`; this hook is just their app-wired seam.
import * as React from 'react'

import { useCompanies } from '@/hooks/use-companies'
import { useUI } from '@/stores/ui-store'
import { inCompanyScope, resolveActiveCompany } from '@/lib/companies'

export interface CompanyScope {
  /** The active scope id: `null` = HQ (main/PA bots), a number = that company. */
  activeCompany: number | null
  /** Whether a session/team/card carrying `companyId` belongs in the current
   *  browse scope. A non-empty SEARCH lifts scope, so callers gate on their query
   *  BEFORE consulting this (the roster idiom). */
  inScope: (companyId: number | null | undefined) => boolean
}

export function useCompanyScope(): CompanyScope {
  const { companies, isLoading, isError } = useCompanies()
  const activeCompany = useUI((s) => s.activeCompany)
  const setActiveCompany = useUI((s) => s.setActiveCompany)

  // Reconcile a stale persisted id against the live set (see file header) — the
  // roster's effect verbatim, so the fail-open-to-HQ rule fires on whichever
  // scoped surface is mounted.
  //
  // ONLY once the list actually resolved — the guard `grok-roster.tsx` already
  // carries, and the reason this hook needed it too. While the query is in
  // flight (or has failed) `companies` is `[]`, which is "we don't know yet",
  // not "there are no companies". Reconciling against that empty set WROTE
  // `activeCompany: null` into the persisted store, so a cold load onto any
  // surface that mounts this hook — `/browser`, `/workflows`, the workflow
  // composer — silently and PERMANENTLY threw the user back to HQ. A PWA
  // reopening on its last route is exactly that cold load, which is why the
  // roster's own fix was not enough. Measured and reproduced on the headless
  // rig before this line existed.
  React.useEffect(() => {
    if (isLoading || isError) return
    if (activeCompany === null) return
    const resolved = resolveActiveCompany(
      activeCompany,
      companies.map((c) => c.id),
    )
    if (resolved !== activeCompany) setActiveCompany(resolved)
  }, [activeCompany, companies, isError, isLoading, setActiveCompany])

  const inScope = React.useCallback(
    (companyId: number | null | undefined) => inCompanyScope(companyId, activeCompany),
    [activeCompany],
  )

  return { activeCompany, inScope }
}
