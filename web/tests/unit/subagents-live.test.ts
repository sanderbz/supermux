/**
 * `subagents_live` — a session whose main turn has settled but whose BACKGROUND
 * workflow is still running must read as WORKING, not done/idle. This pins the
 * frontend half of the signal purely (no DOM): `groupSessions` buckets it active,
 * and `markStateForSession` / the roster's `stateWordFor` draw the working face
 * + word. A session with NO live subagent is byte-identical to today (the signal
 * is absent/falsy), so the stuck-active fix is not regressed.
 */
import { describe, expect, test } from 'bun:test'

import { groupSessions } from '../../src/lib/team-attention'
import { markStateForSession, subagentsClause } from '../../src/lib/mark-status'
import type { ApiSession } from '../../src/lib/api'

const NOW = 1_800_000_000_000

function session(over: Partial<ApiSession> & { name: string; status: ApiSession['status'] }): ApiSession {
  return {
    dir: '',
    provider: 'claude',
    preview_lines: [],
    updated_at: new Date(NOW).toISOString(),
    ...over,
  } as ApiSession
}

describe('groupSessions honours subagents_live', () => {
  test('a settled-idle session with a live workflow buckets ACTIVE, not done', () => {
    const s = session({ name: 'wf', status: 'idle', subagents_live: true })
    const groups = groupSessions([s], new Set(), NOW)
    expect(groups.active.map((x) => x.name)).toEqual(['wf'])
    expect(groups.done).toHaveLength(0)
    expect(groups.idle).toHaveLength(0)
  })

  test('without the signal the SAME idle session is done/idle (behaviour-neutral)', () => {
    const s = session({ name: 'plain', status: 'idle' })
    const groups = groupSessions([s], new Set(), NOW)
    expect(groups.active).toHaveLength(0)
    // idle + same day → done, exactly as before the signal existed.
    expect(groups.done.map((x) => x.name)).toEqual(['plain'])
  })

  test('a needs-you session still wins the needs bucket over a live workflow', () => {
    const s = session({ name: 'needy', status: 'waiting', subagents_live: true })
    const groups = groupSessions([s], new Set(['needy']), NOW)
    expect(groups.needs.map((x) => x.name)).toEqual(['needy'])
    expect(groups.active).toHaveLength(0)
  })
})

describe('markStateForSession draws the working face for a live workflow', () => {
  test('a settled-idle session with subagents_live → working', () => {
    expect(markStateForSession({ status: 'idle', subagents_live: true })).toBe('working')
  })

  test('the same session without the signal → idle (unchanged)', () => {
    expect(markStateForSession({ status: 'idle' })).toBe('idle')
  })

  test('an explicit done moment still outranks a live workflow', () => {
    // The row is bucketed active by groupSessions so it never receives done in
    // practice, but the hint precedence is asserted for totality.
    expect(markStateForSession({ status: 'idle', subagents_live: true }, { done: true })).toBe('done')
  })
})

describe('subagentsClause — the shared parallelism formatter', () => {
  test('only ≥ 2 subagents produce the clause', () => {
    expect(subagentsClause(undefined)).toBe('')
    expect(subagentsClause(0)).toBe('')
    expect(subagentsClause(1)).toBe('')
    expect(subagentsClause(3)).toBe(' · 3 subagents')
  })
})
