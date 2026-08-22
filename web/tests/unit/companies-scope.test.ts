/**
 * The PURE helpers behind the company switcher's whole-app scoping
 * (`src/lib/companies.ts`): the stale-id guard, the browse-scope predicate, and
 * the space-first search ranking. All three are load-bearing — a wrong guard
 * silently scopes to a company that no longer exists; a wrong predicate leaks
 * cross-company sessions into HQ (or hides the main bots); a wrong ranking
 * scrambles the order — so all three are pinned here rather than assumed.
 *
 * NEW model (HQ): `activeCompany === null` is HQ, the main/PA space that shows
 * ONLY sessions with a null/undefined `company_id`. There is NO "All" view that
 * mixes HQ with a company.
 */
import { describe, expect, test } from 'bun:test'

import {
  companyFirstOrder,
  inCompanyScope,
  resolveActiveCompany,
} from '@/lib/companies'

describe('resolveActiveCompany — the stale-id guard', () => {
  test('null in ⇒ null out (already HQ)', () => {
    expect(resolveActiveCompany(null, [1, 2, 3])).toBe(null)
  })

  test('a live id is kept', () => {
    expect(resolveActiveCompany(2, [1, 2, 3])).toBe(2)
  })

  test('a stale id (deleted/archived company) resolves to null (=HQ)', () => {
    expect(resolveActiveCompany(9, [1, 2, 3])).toBe(null)
  })

  test('any id against an empty live set resolves to null (=HQ)', () => {
    expect(resolveActiveCompany(1, [])).toBe(null)
  })
})

describe('inCompanyScope — the browse-scope predicate (no search)', () => {
  test('HQ (null) keeps ONLY main bots — null/undefined company_id, not everything', () => {
    expect(inCompanyScope(null, null)).toBe(true)
    expect(inCompanyScope(undefined, null)).toBe(true)
    // A company session is NOT in HQ.
    expect(inCompanyScope(1, null)).toBe(false)
    expect(inCompanyScope(2, null)).toBe(false)
  })

  test('a company scope keeps ONLY that company — not HQ, not another company', () => {
    expect(inCompanyScope(1, 1)).toBe(true)
    expect(inCompanyScope(2, 1)).toBe(false)
    // A main bot never leaks into a company scope.
    expect(inCompanyScope(null, 1)).toBe(false)
    expect(inCompanyScope(undefined, 1)).toBe(false)
  })
})

describe('companyFirstOrder — stable space-first search ranking', () => {
  const rows = [
    { name: 'a', company_id: 2 },
    { name: 'b', company_id: null },
    { name: 'c', company_id: 1 },
    { name: 'd', company_id: 1 },
    { name: 'e', company_id: 2 },
  ]

  test('HQ (null) floats the main bots to the front, STABLY, keeping companies below', () => {
    const out = companyFirstOrder(rows, null)
    // b (main bot) rises first; the rest keep their relative order — search
    // stays global, HQ-first.
    expect(out.map((r) => r.name)).toEqual(['b', 'a', 'c', 'd', 'e'])
  })

  test('HQ treats undefined company_id as a main bot too', () => {
    const withUndef = [
      { name: 'x', company_id: 1 },
      { name: 'y' as const },
      { name: 'z', company_id: 2 },
    ]
    const out = companyFirstOrder(withUndef, null)
    expect(out.map((r) => r.name)).toEqual(['y', 'x', 'z'])
  })

  test('floats the active company to the front, STABLY, keeping others below', () => {
    const out = companyFirstOrder(rows, 1)
    // c,d (company 1) rise first in their original relative order; a,b,e keep
    // theirs below — cross-space matches stay visible.
    expect(out.map((r) => r.name)).toEqual(['c', 'd', 'a', 'b', 'e'])
  })

  test('a company scope: main/PA bots (company_id null) rank BELOW, with the others', () => {
    const out = companyFirstOrder(rows, 2)
    expect(out.map((r) => r.name)).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  test('empty input ⇒ empty output', () => {
    expect(companyFirstOrder([], 1)).toEqual([])
    expect(companyFirstOrder([], null)).toEqual([])
  })
})
