// The turn state machine's reconcile decisions (stop-state honesty fix).
//
// Two defects this covers, both live in Grok/Bot mode: a cancelled turn that
// stays "thinking" long after the session went idle, and a Stop that fires an
// Escape into a pty with nothing to interrupt — a silent no-op. Both come down
// to WHEN the client's live-turn anchor (`turnStart`) is allowed to drop. The
// stateful hook drives that from effects + a websocket, so the DECISIONS are
// pulled out as pure functions and asserted here.

import { describe, expect, test } from 'bun:test'

import { shouldEndTurn } from '../../src/components/chat/use-chat-turn'
import { stopReconcile } from '../../src/components/chat/use-composer'

const base = {
  active: false,
  turnStart: 1_000,
  confirmedCaughtUp: false,
  turnStranded: false,
  terminalRest: false,
  idleSettled: false,
}

describe('shouldEndTurn — when the live-turn anchor is torn down', () => {
  test('no anchor → nothing to tear down', () => {
    expect(shouldEndTurn({ ...base, turnStart: null })).toBe(false)
  })

  test('a still-`active` turn is NEVER torn down here, however long it has run', () => {
    // A live turn is not over just because time passed — a 3-minute turn is
    // still a turn. Only the user's Stop (`endTurn`, imperative) ends a live one.
    // `idleSettled` cannot fire while active (it is gated on `!active` upstream),
    // but assert the guard holds even if the pieces are inconsistent.
    expect(shouldEndTurn({ ...base, active: true, turnStranded: true })).toBe(false)
    expect(shouldEndTurn({ ...base, active: true, terminalRest: true })).toBe(false)
    expect(shouldEndTurn({ ...base, active: true, confirmedCaughtUp: true })).toBe(false)
    expect(shouldEndTurn({ ...base, active: true, idleSettled: true })).toBe(false)
  })

  test('just idle, still within the confirm bridge → HELD', () => {
    // The deliberate bridge: the session left `active` moments ago and the
    // confirming batch for the answer may still be landing. Blanking the
    // provisional tail now would flash empty before the confirmed form arrives.
    expect(shouldEndTurn({ ...base, active: false })).toBe(false)
  })

  test('idle PAST the confirm bridge → torn down (the desync fix)', () => {
    // The owner's bug: the pty is already at its prompt (idle/stopped), but the
    // chat plane kept "thinking" because no confirming batch ever came for a
    // cancelled turn — and the only ceiling was 120s from the turn START. The
    // idle-edge settle reconciles the chat plane with the quiet pty promptly.
    expect(shouldEndTurn({ ...base, idleSettled: true })).toBe(true)
  })

  test('idle AND the confirming batch has landed → torn down', () => {
    expect(shouldEndTurn({ ...base, confirmedCaughtUp: true })).toBe(true)
  })

  test('a TERMINAL rest (stopped/error) tears down at once — no batch is coming', () => {
    // The fix's passive half: `stopped`/`error` can never satisfy the caught-up
    // gate, so before this the live layer sat "thinking" until the 120s ceiling.
    expect(shouldEndTurn({ ...base, terminalRest: true })).toBe(true)
  })

  test('the bounded ceiling is still the backstop for a batch that never lands', () => {
    expect(shouldEndTurn({ ...base, turnStranded: true })).toBe(true)
  })
})

describe('stopReconcile — the honest half of Stop', () => {
  test('a DELIVERED interrupt reconciles the local turn to idle', () => {
    // Whether it ended a running turn or found nothing to end, the surface must
    // stop thinking — Stop is never a silent no-op.
    expect(stopReconcile(true)).toBe(true)
  })

  test('a THROWN interrupt does NOT reconcile — that is the "still running" case', () => {
    // The genuine failure the `stop-failed` notice owns: the interrupt did not
    // reach a still-running turn, so the client must not pretend it is idle.
    expect(stopReconcile(false)).toBe(false)
  })
})
