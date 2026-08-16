/**
 * The recall popover's kind chip must survive every kind the SERVER can emit.
 * ─────────────────────────────────────────────────────────────────────────────
 * The badge map is a `Record` over the client's `RecallEntryKind` union, so TS
 * guarantees it is total over what the CLIENT knows. Nothing guarantees the
 * union still mirrors `recall.rs`'s `Kind` enum — that mirror is maintained by
 * hand across two languages, and the lookup used to be `KIND_BADGE[kind].label`
 * with no fallback. A server that ships a kind first (a new wrapper tag, or
 * simply a cached SPA talking to a freshly deployed server) therefore did not
 * render an unknown chip: it threw, taking the whole popover down.
 *
 * Three guards, failing in different eras:
 *   · `delegation` is mapped — the kind `agents/delegate.rs` emits today,
 *   · a delegated turn is attributed to its SENDER, never "You" or "System",
 *   · a kind the client has never heard of degrades to a plain chip.
 */
import { describe, expect, test } from 'bun:test'

import {
  kindBadgeMeta,
  kindSpeaker,
} from '../../src/components/focus-mode/recall-kind-meta'
import type { RecallEntryKind } from '../../src/lib/api/sessions'

describe('recall kind badge', () => {
  test('a delegated prompt gets its own chip', () => {
    expect(kindBadgeMeta('delegation')?.label).toBe('delegated')
  })

  test('a delegated prompt is attributed to the sending session', () => {
    expect(kindSpeaker('delegation', 'git-stacker')).toBe('git-stacker')
    // Never "You": the owner did not type it.
    expect(kindSpeaker('delegation')).not.toBe('You')
  })

  test('a scheduled prompt gets its own chip and names its schedule', () => {
    expect(kindBadgeMeta('schedule')?.label).toBe('scheduled')
    expect(kindSpeaker('schedule', 'Nightly release watch')).toBe('Nightly release watch')
    // Never "You": the owner asked for it once, not at 03:00.
    expect(kindSpeaker('schedule')).not.toBe('You')
  })

  test('a kind the client has never heard of degrades instead of throwing', () => {
    // A cached SPA routinely talks to a newer server: whatever wrapper kind
    // lands next must render as its own raw name, not throw.
    const future = 'sourdough' as RecallEntryKind
    expect(kindBadgeMeta(future)?.label).toBe('sourdough')
  })

  test('prompts stay unlabelled and stay the owner', () => {
    expect(kindBadgeMeta('prompt')).toBeNull()
    expect(kindSpeaker('prompt')).toBe('You')
  })
})
