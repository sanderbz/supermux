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
  companiesNeedingAttention,
  companyFilesRoot,
  companyFirstOrder,
  companyForDigit,
  confineToCompanyRoot,
  inCompanyScope,
  resolveActiveCompany,
  type Company,
} from '@/lib/companies'
import { canMentionPeer, scopeMentionPeers } from '@/lib/mention-scope'
import { rosteredTeams, totalBotCount } from '@/lib/team-attention'
import type { MemberStatus, Team, TeamMember } from '@/lib/api/teams'

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

describe('companyForDigit — the ⌘/Ctrl+1..9 jump-to-Nth', () => {
  const companies: Company[] = [
    { id: 10, slug: 'acme', display_name: 'Acme', root_dir: '/srv/acme', archived: 0 },
    { id: 20, slug: 'globex', display_name: 'Globex', root_dir: '/srv/globex', archived: 0 },
    { id: 30, slug: 'initech', display_name: 'Initech', root_dir: '/srv/initech', archived: 0 },
  ]

  test('1-based digit selects the Nth company', () => {
    expect(companyForDigit(companies, 1)?.id).toBe(10)
    expect(companyForDigit(companies, 2)?.id).toBe(20)
    expect(companyForDigit(companies, 3)?.id).toBe(30)
  })

  test('a digit past the end resolves to undefined (no-op, never a wrong jump)', () => {
    expect(companyForDigit(companies, 4)).toBeUndefined()
    expect(companyForDigit(companies, 9)).toBeUndefined()
  })

  test('0 / negative / non-integer digits are no-ops', () => {
    expect(companyForDigit(companies, 0)).toBeUndefined()
    expect(companyForDigit(companies, -1)).toBeUndefined()
    expect(companyForDigit(companies, 1.5)).toBeUndefined()
  })

  test('an empty company set never jumps', () => {
    expect(companyForDigit([], 1)).toBeUndefined()
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

describe('confineToCompanyRoot — the Files-browser confinement clamp', () => {
  const root = '/opt/projects/companies/acme'

  test('HQ (null root) never clamps — the path passes through unchanged', () => {
    expect(confineToCompanyRoot('/home/owner', null)).toBe('/home/owner')
    expect(confineToCompanyRoot('~', null)).toBe('~')
    expect(confineToCompanyRoot('/etc', null)).toBe('/etc')
  })

  test('the company root itself is in-bounds (returned as-is)', () => {
    expect(confineToCompanyRoot(root, root)).toBe(root)
  })

  test('a descendant path stays put — navigation WITHIN the company is free', () => {
    expect(confineToCompanyRoot(`${root}/docs`, root)).toBe(`${root}/docs`)
    expect(confineToCompanyRoot(`${root}/docs/q3/report.md`, root)).toBe(
      `${root}/docs/q3/report.md`,
    )
  })

  test('a path OUTSIDE the company root clamps back to the root', () => {
    // Walking up to a parent…
    expect(confineToCompanyRoot('/opt/projects/companies', root)).toBe(root)
    // …an unrelated absolute…
    expect(confineToCompanyRoot('/home/owner/.ssh', root)).toBe(root)
    expect(confineToCompanyRoot('~', root)).toBe(root)
    // …and the filesystem root.
    expect(confineToCompanyRoot('/', root)).toBe(root)
  })

  test('a sibling that merely SHARES the root as a name prefix is NOT in-bounds', () => {
    // `/…/acme-corp` must not be treated as inside `/…/acme` (no `/` boundary).
    expect(confineToCompanyRoot('/opt/projects/companies/acme-corp', root)).toBe(root)
    expect(confineToCompanyRoot('/opt/projects/companies/acme-corp/x', root)).toBe(root)
  })

  test('trailing slashes on either side do not break the boundary check', () => {
    expect(confineToCompanyRoot(`${root}/`, root)).toBe(`${root}/`)
    expect(confineToCompanyRoot(`${root}/docs`, `${root}/`)).toBe(`${root}/docs`)
    expect(confineToCompanyRoot('/opt/projects', `${root}/`)).toBe(`${root}/`)
  })
})

/* ── the polish items: scoped census + per-company attention dots ───────────── */

let seq = 0
function member(status: MemberStatus): TeamMember {
  const name = `m${seq++}`
  return {
    name,
    agent_id: `${name}@t`,
    model: 'claude-sonnet-4',
    color: '',
    tmux_pane_id: '%1',
    is_active: true,
    status,
  }
}
function team(over: Partial<Team> = {}): Team {
  return {
    team_name: over.team_name ?? `team-${seq++}`,
    lead_session: 'lead',
    lead_supermux_session: over.lead_supermux_session ?? 'supermux-lead',
    members: over.members ?? [member('idle')],
    tasks: over.tasks ?? [],
    ...over,
  }
}

/** The roster's own census derivation, reproduced from the SAME pure helpers the
 *  component uses (`inCompanyScope` → `filtered`/`filteredTeams` → `totalBotCount`
 *  / `rosteredTeams`). Pins the scoped counts without a DOM. */
function scopedCensus(
  allSessions: readonly { name: string; company_id?: number | null }[],
  nonLeadSessions: readonly { name: string; company_id?: number | null }[],
  teams: readonly Team[],
  activeCompany: number | null,
) {
  const filtered = nonLeadSessions.filter((s) => inCompanyScope(s.company_id, activeCompany))
  const companyByName = new Map<string, number | null>()
  for (const s of allSessions) companyByName.set(s.name, s.company_id ?? null)
  const filteredTeams = teams.filter((t) =>
    inCompanyScope(companyByName.get(t.lead_supermux_session ?? '') ?? null, activeCompany),
  )
  return {
    bots: totalBotCount(filtered.length, filteredTeams),
    crews: rosteredTeams(filteredTeams).length,
  }
}

describe('scoped census — the header count reads the active company, not the fleet', () => {
  // 15 bots total: 2 in Acme (id 1), 3 in Globex (id 2), 10 at HQ (null).
  const acme = [
    { name: 'acme-a', company_id: 1 },
    { name: 'acme-b', company_id: 1 },
  ]
  const globex = [
    { name: 'globex-a', company_id: 2 },
    { name: 'globex-b', company_id: 2 },
    { name: 'globex-c', company_id: 2 },
  ]
  const hq = Array.from({ length: 10 }, (_, i) => ({ name: `hq-${i}`, company_id: null }))
  const nonLeadSessions = [...acme, ...globex, ...hq]

  test('Acme (2 bots) reads 2, NOT the global 15', () => {
    const { bots } = scopedCensus(nonLeadSessions, nonLeadSessions, [], 1)
    expect(bots).toBe(2)
  })

  test('HQ (null) reads only the 10 main/PA bots, not the company bots', () => {
    const { bots } = scopedCensus(nonLeadSessions, nonLeadSessions, [], null)
    expect(bots).toBe(10)
  })

  test('a scoped crew adds its members + lead to the company headcount', () => {
    // A Globex team: its lead is a Globex session, so it scopes to Globex only.
    const lead = { name: 'globex-lead', company_id: 2 }
    const t = team({ lead_supermux_session: 'globex-lead', members: [member('idle'), member('working')] })
    const all = [...nonLeadSessions, lead]
    const globexCensus = scopedCensus(all, nonLeadSessions, [t], 2)
    // 3 standalone Globex bots + 2 crew members + 1 mapped lead = 6; 1 crew.
    expect(globexCensus.bots).toBe(6)
    expect(globexCensus.crews).toBe(1)
    // Acme never sees the Globex crew.
    const acmeCensus = scopedCensus(all, nonLeadSessions, [t], 1)
    expect(acmeCensus.bots).toBe(2)
    expect(acmeCensus.crews).toBe(0)
  })

  test('all-HQ (no companies) is byte-identical to the old unfiltered census', () => {
    const flat = [
      { name: 'a', company_id: null },
      { name: 'b', company_id: null },
      { name: 'c' as const },
    ]
    const { bots } = scopedCensus(flat, flat, [], null)
    expect(bots).toBe(totalBotCount(flat.length, []))
    expect(bots).toBe(3)
  })
})

describe('companiesNeedingAttention — the switcher dots reuse the roster predicate', () => {
  const sessions = [
    { name: 'acme-a', company_id: 1 },
    { name: 'acme-b', company_id: 1 },
    { name: 'globex-a', company_id: 2 },
    { name: 'hq-a', company_id: null },
    { name: 'hq-b' as const }, // undefined company_id = HQ bot
  ]
  // The injected needs-you predicate stands in for the roster's `needNames.has`.
  const needsYou = (names: string[]) => (name: string) => names.includes(name)

  test('a needy bot lights its OWN company, not the others', () => {
    const set = companiesNeedingAttention(sessions, needsYou(['acme-a']))
    expect(set.has(1)).toBe(true)
    expect(set.has(2)).toBe(false)
    expect(set.has(null)).toBe(false)
  })

  test('an HQ (null / undefined company_id) bot lights the HQ dot', () => {
    expect(companiesNeedingAttention(sessions, needsYou(['hq-a'])).has(null)).toBe(true)
    // undefined company_id folds to the same HQ key.
    expect(companiesNeedingAttention(sessions, needsYou(['hq-b'])).has(null)).toBe(true)
  })

  test('several companies can light at once; a calm company stays dark', () => {
    const set = companiesNeedingAttention(sessions, needsYou(['acme-a', 'globex-a']))
    expect(set.has(1)).toBe(true)
    expect(set.has(2)).toBe(true)
    expect(set.has(null)).toBe(false)
  })

  test('no needy bots ⇒ an empty set (every dot dark)', () => {
    expect(companiesNeedingAttention(sessions, needsYou([])).size).toBe(0)
  })
})
