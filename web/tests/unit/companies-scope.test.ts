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
  companyFilesRoot,
  companyFirstOrder,
  inCompanyScope,
  resolveActiveCompany,
  type Company,
} from '@/lib/companies'
import { canMentionPeer, scopeMentionPeers } from '@/lib/mention-scope'

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

describe('canMentionPeer — the @-picker same-company predicate', () => {
  test('a main/HQ session (self company_id null/undefined) can reach ANY peer', () => {
    expect(canMentionPeer(null, null)).toBe(true)
    expect(canMentionPeer(null, 1)).toBe(true)
    expect(canMentionPeer(null, 2)).toBe(true)
    expect(canMentionPeer(undefined, 3)).toBe(true)
  })

  test('a company session sees ONLY same-company peers', () => {
    expect(canMentionPeer(1, 1)).toBe(true)
    // Another company is hidden.
    expect(canMentionPeer(1, 2)).toBe(false)
    // A main/PA bot is NOT reachable from inside a company.
    expect(canMentionPeer(1, null)).toBe(false)
    expect(canMentionPeer(1, undefined)).toBe(false)
  })
})

describe('scopeMentionPeers — filtering the picker session list', () => {
  const sessions = [
    { name: 'acme-a', company_id: 1 },
    { name: 'acme-b', company_id: 1 },
    { name: 'globex-a', company_id: 2 },
    { name: 'main-a', company_id: null },
    { name: 'main-b' as const }, // undefined company_id = main bot
  ]

  test('a company session keeps only its own peers', () => {
    const out = scopeMentionPeers(sessions, 1)
    expect(out.map((s) => s.name)).toEqual(['acme-a', 'acme-b'])
  })

  test('a main/HQ session (null) sees ALL sessions — main can reach any', () => {
    const out = scopeMentionPeers(sessions, null)
    expect(out.map((s) => s.name)).toEqual([
      'acme-a',
      'acme-b',
      'globex-a',
      'main-a',
      'main-b',
    ])
  })

  test('a company with no same-company peers yields an empty picker', () => {
    expect(scopeMentionPeers(sessions, 3).map((s) => s.name)).toEqual([])
  })
})

describe('companyFilesRoot — the Files-browser starting root', () => {
  const companies: Company[] = [
    { id: 1, slug: 'acme', display_name: 'Acme', root_dir: '/srv/acme', archived: 0 },
    { id: 2, slug: 'globex', display_name: 'Globex', root_dir: '/srv/globex', archived: 0 },
  ]

  test('HQ (activeCompany null) ⇒ null = unrestricted (owner sees everything)', () => {
    expect(companyFilesRoot(null, companies)).toBe(null)
  })

  test('an active company ⇒ its root_dir', () => {
    expect(companyFilesRoot(1, companies)).toBe('/srv/acme')
    expect(companyFilesRoot(2, companies)).toBe('/srv/globex')
  })

  test('a stale/unknown active id fails open to null (=HQ, unrestricted)', () => {
    expect(companyFilesRoot(9, companies)).toBe(null)
    expect(companyFilesRoot(1, [])).toBe(null)
  })
})
