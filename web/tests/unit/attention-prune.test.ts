/**
 * The seam between the roster and the seen-cursors — the one the 76 green
 * attention tests never touched.
 *
 * `lib/attention-tiers.ts` is pure and heavily tested; `hooks/use-attention.ts`
 * is where the state lives, and it shipped with a one-character defect that
 * deleted every cursor on the device: the roster signature was JOINED with NUL
 * and SPLIT on a space, so `live` was a single NUL-joined blob matching no
 * session name, every stored cursor was judged dead, and the first render after
 * boot rewrote `supermux:seen` to `{}`. Seeding a cursor and tracing
 * `Storage.setItem` showed exactly one write, value `{}` — and with it went
 * every "Mark unread" the user had set.
 *
 * So the prune is a pure function now, and these are the tests that would have
 * caught it: they drive the SAME `rosterSignature` the hook memoises on, so the
 * two sides of the separator can never drift apart again without going red.
 */
import { describe, expect, test } from 'bun:test'

import { pruneSeen, rosterSignature, type SeenMap } from '../../src/hooks/use-attention'

const seeded: SeenMap = {
  'vx-alpha': { ts: 1000 },
  'vx-bravo': { ts: 2000, unread: true },
  'vx-gone': { ts: 3000 },
}

describe('the prune keeps the cursors of live sessions', () => {
  test('a survivor is still there after a session is dropped', () => {
    const kept = pruneSeen(seeded, rosterSignature(['vx-alpha', 'vx-bravo']))
    expect(kept).not.toBeNull()
    expect(Object.keys(kept!).sort()).toEqual(['vx-alpha', 'vx-bravo'])
    // The whole cursor survives, not merely the key: `unread` is what "Mark
    // unread" writes and losing it is the same as never having marked it.
    expect(kept!['vx-bravo']).toEqual({ ts: 2000, unread: true })
  })

  test('the whole map is NOT wiped when every session is alive', () => {
    // The shipped failure, stated directly. Before the fix this returned `{}`
    // for a roster on which nothing had been deleted at all.
    const names = Object.keys(seeded)
    expect(pruneSeen(seeded, rosterSignature(names))).toBeNull()
  })

  test('nothing dropped ⇒ no write', () => {
    // `null` means "do not touch storage" — a steady-state roster re-renders
    // constantly and must not rewrite the key on every pass.
    expect(pruneSeen({}, rosterSignature(['a']))).toBeNull()
  })

  test('an empty roster prunes nothing — it is "not loaded yet", not "all gone"', () => {
    expect(pruneSeen(seeded, rosterSignature([]))).toBeNull()
  })

  test('order does not matter — the signature is sorted', () => {
    expect(rosterSignature(['b', 'a'])).toBe(rosterSignature(['a', 'b']))
  })

  test('a name that merely CONTAINS the separator-adjacent text is not confused', () => {
    // A space is a legal-looking character in a display context; NUL is not,
    // which is why it is the separator. Pin it: two names that would collide
    // under a space join stay distinct.
    const map: SeenMap = { 'a b': { ts: 1 }, a: { ts: 2 }, b: { ts: 3 } }
    const kept = pruneSeen(map, rosterSignature(['a b']))
    expect(kept).not.toBeNull()
    expect(Object.keys(kept!)).toEqual(['a b'])
  })
})
