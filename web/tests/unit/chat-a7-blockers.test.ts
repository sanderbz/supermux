/**
 * The two A7-blockers A6 closed on the client side (T4.1, T4.2).
 * ─────────────────────────────────────────────────────────────────────────────
 * Both are the same failure shape and it is the shape A0's `b8daf73` lesson is
 * about: a signal that is dead, that nothing observes, and that therefore
 * survives for weeks. Neither is visible in a rendered snapshot — the first is
 * an ABSENCE, and the second is an affordance that exists but leads nowhere.
 */
import { describe, expect, test } from 'bun:test'

import { isSubagent, toChatEntries, truncatedUuids } from '../../src/components/chat/wire-entries'
import { clipStateFor, NO_REQUEST } from '../../src/components/chat/truncation'
import type { WireEntry } from '../../src/components/chat/wire'

function wire(over: Partial<WireEntry> & { seq: number; uuid: string }): WireEntry {
  return {
    kind: 'assistant',
    ts_ms: 1_000,
    offset: 0,
    oversize: false,
    truncated: false,
    body: { text: 'hello' },
    ...over,
  }
}

/* ── T4.1: the subagent decision is total ────────────────────────────────── */

describe('subagent turns (A6 T4.1)', () => {
  test('the predicate is the single place the rule lives', () => {
    expect(isSubagent(wire({ seq: 1, uuid: 'a' }))).toBe(false)
    expect(isSubagent(wire({ seq: 2, uuid: 'b', agent_id: 'x1' }))).toBe(true)
  })

  test('they are dropped from the rendered list — deliberately, not accidentally', () => {
    const out = toChatEntries([
      wire({ seq: 1, uuid: 'm1' }),
      wire({ seq: 2, uuid: 's1', agent_id: 'x1' }),
      wire({ seq: 3, uuid: 'm2' }),
    ])
    expect(out.map((e) => e.uuid).sort()).toEqual(['m1', 'm2'])
  })

  test('a subagent uuid is NEVER asked for — the fetch that would 404 is unreachable', () => {
    // This is the assertion that matters. The server-side 404 is fixed
    // (`ws.rs::find_full_entry_anywhere` now sweeps `subagents/` too), but the
    // client must still not spend a `find_full_entry` scan on a body it will
    // not draw. Before A6 this held by coincidence — two layers happening to
    // agree — rather than by a named rule.
    const uuids = truncatedUuids(
      [
        wire({ seq: 1, uuid: 'm1', truncated: true }),
        wire({ seq: 2, uuid: 's1', truncated: true, agent_id: 'x1' }),
      ],
      12,
    )
    expect(uuids).toEqual(['m1'])
    expect(uuids).not.toContain('s1')
  })

  test('a subagent turn does not consume the auto-fetch window', () => {
    // The window is the newest 12 RENDERED entries. If subagent turns counted
    // against it, a fan-out would push real clipped messages out of the window
    // and make them permanently unrecoverable — the exact failure T4.2 fixes,
    // caused by the thing T4.1 is about.
    const entries: WireEntry[] = []
    for (let i = 0; i < 20; i++) {
      entries.push(wire({ seq: i * 2, uuid: `s${i}`, agent_id: 'x1', truncated: true }))
    }
    entries.push(wire({ seq: 100, uuid: 'm1', truncated: true }))
    expect(truncatedUuids(entries, 12)).toEqual(['m1'])
  })
})

/* ── T4.2: a clipped entry is recoverable, and says which state it is in ── */

describe('the clipped-entry state machine (A6 T4.2)', () => {
  const seam = (fetching: string[], failed: string[]) => ({
    fetching: new Set(fetching),
    failed: new Set(failed),
    request: NO_REQUEST,
  })

  test('three states, and the default is the honest one', () => {
    expect(clipStateFor('a', seam([], []))).toBe('clipped')
    expect(clipStateFor('a', seam(['a'], []))).toBe('loading')
    expect(clipStateFor('a', seam([], ['a']))).toBe('failed')
  })

  test('in-flight beats failed — a retry that is running is not still a failure', () => {
    // The socket keeps a uuid in `failed` until the retry resolves, so without
    // this precedence the button would read "try again" while the try was
    // already in flight, and a second tap would be a no-op the user cannot
    // tell from a broken button.
    expect(clipStateFor('a', seam(['a'], ['a']))).toBe('loading')
  })

  test('the inert seam is referentially identifiable, so no dead button ships', () => {
    // A bench or a unit-test render has no data plane behind it. The marker
    // must degrade to the A3 label rather than to a button that does nothing —
    // the failure this whole task exists to remove.
    expect(seam([], []).request).toBe(NO_REQUEST)
  })
})
