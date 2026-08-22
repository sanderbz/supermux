/**
 * The two PURE helpers behind the company switcher's whole-app scoping
 * (`src/lib/companies.ts`): the stale-id guard and the company-first search
 * ranking. Both are load-bearing — a wrong guard silently scopes to a company
 * that no longer exists; a wrong ranking either hides cross-company matches or
 * scrambles the order — so both are pinned here rather than assumed.
 */
import { describe, expect, test } from 'bun:test'

import { companyFirstOrder, resolveActiveCompany } from '@/lib/companies'

describe('resolveActiveCompany — the stale-id guard', () => {
  test('null in ⇒ null out (already the "All" scope)', () => {
    expect(resolveActiveCompany(null, [1, 2, 3])).toBe(null)
  })

  test('a live id is kept', () => {
    expect(resolveActiveCompany(2, [1, 2, 3])).toBe(2)
  })

  test('a stale id (deleted/archived company) resolves to null', () => {
    expect(resolveActiveCompany(9, [1, 2, 3])).toBe(null)
  })

  test('any id against an empty live set resolves to null', () => {
    expect(resolveActiveCompany(1, [])).toBe(null)
  })
})

describe('companyFirstOrder — stable company-first search ranking', () => {
  const rows = [
    { name: 'a', company_id: 2 },
    { name: 'b', company_id: null },
    { name: 'c', company_id: 1 },
    { name: 'd', company_id: 1 },
    { name: 'e', company_id: 2 },
  ]

  test('null activeCompany is a no-op copy (order + identity preserved, new array)', () => {
    const out = companyFirstOrder(rows, null)
    expect(out.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(out).not.toBe(rows)
  })

  test('floats the active company to the front, STABLY, keeping others below', () => {
    const out = companyFirstOrder(rows, 1)
    // c,d (company 1) rise first in their original relative order; a,b,e keep
    // theirs below — cross-company matches stay visible.
    expect(out.map((r) => r.name)).toEqual(['c', 'd', 'a', 'b', 'e'])
  })

  test('main/PA bots (company_id null) never count as in-company', () => {
    const out = companyFirstOrder(rows, 2)
    expect(out.map((r) => r.name)).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  test('empty input ⇒ empty output', () => {
    expect(companyFirstOrder([], 1)).toEqual([])
  })
})
