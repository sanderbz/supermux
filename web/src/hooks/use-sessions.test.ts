// Delta-merge unit tests for the sessions cache.
//
// The archive race is the reason this file exists: the server broadcasts the
// archive removal and the twin `status: 'stopped'` update from different tasks,
// so the stop delta can land AFTER the removal and resurrect a ghost row.
//
// Archive tombstones live for the module's lifetime, so every test uses its own
// session names instead of resetting shared state.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyDelta } from '@/hooks/use-sessions'
import { forgetTombstonesFor } from '@/lib/archive-tombstones'
import type { ApiSession } from '@/lib/api'

function row(name: string, extra: Partial<ApiSession> = {}): ApiSession {
  return {
    name,
    status: 'idle',
    dir: '/tmp/' + name,
    provider: 'claude',
    preview_lines: ['hello'],
    ...extra,
  } as ApiSession
}

afterEach(() => {
  vi.useRealTimers()
})

describe('applyDelta', () => {
  it('drops the row an archive delta announces', () => {
    const list = applyDelta(
      [row('drop-me'), row('keeper')],
      [{ name: 'drop-me', archived: true }],
      true,
    )
    expect(list.map((s) => s.name)).toEqual(['keeper'])
  })

  it('ignores a late stop delta for a session just archived', () => {
    const archived = applyDelta(
      [row('late-stop'), row('keeper')],
      [{ name: 'late-stop', archived: true }],
      true,
    )
    const after = applyDelta(archived, [{ name: 'late-stop', status: 'stopped' }], true)
    expect(after.map((s) => s.name)).toEqual(['keeper'])
  })

  it('does not merge into a row that came back while tombstoned', () => {
    // A row that IS in the cache, archived, then targeted by a partial delta:
    // it must be neither re-added nor merged, even if something else put it
    // back in the list (a stale in-flight refetch, an optimistic write).
    const archived = applyDelta([row('no-merge')], [{ name: 'no-merge', archived: true }], true)
    expect(archived).toEqual([])
    const resurrected = [row('no-merge')]
    const after = applyDelta(
      resurrected,
      [{ name: 'no-merge', status: 'stopped', preview_lines: ['ghost'] }],
      true,
    )
    expect(after[0].status).toBe('idle')
    expect(after[0].preview_lines).toEqual(['hello'])
  })

  it('re-adds the row when the unarchive broadcast arrives', () => {
    const archived = applyDelta([row('comes-back')], [{ name: 'comes-back', archived: true }], true)
    const back = applyDelta(archived, [{ ...row('comes-back'), archived: false }], true)
    expect(back.map((s) => s.name)).toEqual(['comes-back'])
    expect(back[0].dir).toBe('/tmp/comes-back')
    // The tombstone is gone, so the session lives its normal life again.
    const stopped = applyDelta(back, [{ name: 'comes-back', status: 'stopped' }], true)
    expect(stopped[0].status).toBe('stopped')
  })

  it('stops suppressing an archived name once the tombstone expires', () => {
    vi.useFakeTimers()
    const archived = applyDelta([row('expires')], [{ name: 'expires', archived: true }], true)
    expect(archived).toEqual([])
    vi.advanceTimersByTime(6 * 60_000)
    const later = applyDelta(archived, [{ name: 'expires', status: 'stopped' }], true)
    expect(later.map((s) => s.name)).toEqual(['expires'])
  })

  it('still adds an unknown session from a partial delta', () => {
    const list = applyDelta([row('a')], [{ name: 'fresh', status: 'stopped' }], true)
    expect(list.map((s) => s.name)).toEqual(['a', 'fresh'])
    expect(list[1].status).toBe('stopped')
    expect(list[1].preview_lines).toEqual([])
  })

  it('never adds an unknown session when adds are disallowed', () => {
    const list = applyDelta([row('a')], [{ name: 'status-only', status: 'stopped' }], false)
    expect(list.map((s) => s.name)).toEqual(['a'])
  })
})

describe('forgetTombstonesFor', () => {
  // The choke point: `sessionsApi.list` calls this on every full list response,
  // whichever observer of the ['sessions'] key owns the fetch.
  it('lets a listed session take deltas again', () => {
    const listed = [row('relisted')]
    applyDelta(listed, [{ name: 'relisted', archived: true }], true)
    forgetTombstonesFor(listed)
    const after = applyDelta(listed, [{ name: 'relisted', status: 'stopped' }], true)
    expect(after[0].status).toBe('stopped')
  })

  it('leaves the tombstone of a name the server did not list', () => {
    applyDelta([row('still-gone')], [{ name: 'still-gone', archived: true }], true)
    forgetTombstonesFor([row('someone-else')])
    const after = applyDelta([], [{ name: 'still-gone', status: 'stopped' }], true)
    expect(after).toEqual([])
  })
})
