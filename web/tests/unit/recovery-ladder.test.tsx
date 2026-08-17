/**
 * T8 — the recovery ladder's client model.
 *
 * §15.5 asks for a graded, consequence-labelled ladder, inline AND canonical.
 * What makes it a ladder rather than three buttons is the ORDERING and the
 * LABELLING, and both are decisions that can silently rot: someone reorders the
 * array, someone shortens a label to fit, someone drops the `destroys` half
 * because it looks alarming. Each of those turns the ladder into a trap, and
 * none of them would fail a rendering test.
 *
 * So this file asserts the model, not the markup: order, completeness, and the
 * one thing the inline affordance must get right — offering the LOWEST rung
 * that can actually help.
 */
import { describe, expect, test } from 'bun:test'

import {
  RUNGS,
  canRecoverHolder,
  lowestUsefulRung,
  rungsFor,
} from '../../src/hooks/use-recovery'
import { RECOVERY } from '../../src/brand/copy'

const native = { runtime: 'native', host_id: null }
const tmux = { runtime: 'tmux', host_id: null }
const remote = { runtime: 'native', host_id: 3 }

describe('the ladder is ordered least-destructive first', () => {
  test('the order is recover → restart → reset', () => {
    // The ordering IS the design: a user scanning under pressure should be able
    // to stop at the first rung that keeps what they still need.
    expect([...RUNGS]).toEqual(['recover', 'restart', 'reset'])
    expect(rungsFor(native).map((r) => r.key)).toEqual(['recover', 'restart', 'reset'])
  })

  test('each rung is strictly more destructive than the one before it', () => {
    // Encoded as what each preserves: recover keeps the conversation, restart
    // keeps it too but loses the terminal, reset clears it.
    const [recover, restart, reset] = rungsFor(native)
    expect(recover!.preserves.toLowerCase()).toContain('scrollback')
    expect(restart!.preserves.toLowerCase()).toContain('conversation')
    expect(reset!.destroys.toLowerCase()).toContain('conversation')
  })
})

describe('every rung states both halves', () => {
  test('no rung ships without saying what it destroys', () => {
    // The `destroys` sentence is what prevents regret. A rung that only says
    // what it keeps is worse than one that says nothing, because it reads as a
    // promise.
    for (const rung of rungsFor(native)) {
      expect(rung.label.trim()).not.toBe('')
      expect(rung.preserves.trim()).not.toBe('')
      expect(rung.destroys.trim()).not.toBe('')
    }
  })

  test('the labels are distinct — three rungs, three names', () => {
    const labels = rungsFor(native).map((r) => r.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('recover is blocked where it cannot work, and says why', () => {
  test('a native local session can be recovered in place', () => {
    expect(canRecoverHolder(native)).toBe(true)
    expect(rungsFor(native)[0]!.blockedReason).toBeUndefined()
  })

  test('a tmux session cannot — there is no holder to recover', () => {
    expect(canRecoverHolder(tmux)).toBe(false)
    expect(rungsFor(tmux)[0]!.blockedReason).toBe(RECOVERY.recoverBlocked)
  })

  test('a remote session cannot — the holder is not ours to restart', () => {
    expect(canRecoverHolder(remote)).toBe(false)
    expect(rungsFor(remote)[0]!.blockedReason).toBe(RECOVERY.recoverBlocked)
  })

  test('a blocked rung uses the SAME sentence everywhere', () => {
    // §15.5: "blocked things state why with the same sentence everywhere". One
    // string in `brand/copy.ts`, two call sites (the inline action and the
    // Settings list) — so a reworded explanation is a diff in both.
    expect(rungsFor(tmux)[0]!.blockedReason).toBe(rungsFor(remote)[0]!.blockedReason)
    expect(RECOVERY.recoverBlocked.toLowerCase()).toContain('restart')
  })

  test('restart and reset are never blocked — they work everywhere', () => {
    for (const s of [native, tmux, remote]) {
      const [, restart, reset] = rungsFor(s)
      expect(restart!.blockedReason).toBeUndefined()
      expect(reset!.blockedReason).toBeUndefined()
    }
  })
})

describe('the inline affordance offers the lowest rung that can help', () => {
  test('a native session is offered Recover, the gentlest rung', () => {
    expect(lowestUsefulRung(native).key).toBe('recover')
  })

  test('a tmux session skips the blocked rung and is offered Restart', () => {
    // The failure this prevents: offering a button whose only possible answer
    // is "this session type cannot be recovered".
    expect(lowestUsefulRung(tmux).key).toBe('restart')
  })

  test('a remote session likewise falls through to Restart', () => {
    expect(lowestUsefulRung(remote).key).toBe('restart')
  })

  test('an unknown session still yields a usable rung, never undefined', () => {
    // The badge renders before the row loads. A crash there would replace the
    // error message the user actually needs to read.
    const rung = lowestUsefulRung(null)
    expect(RUNGS).toContain(rung.key)
    expect(rung.label.trim()).not.toBe('')
  })

  test('it never offers a blocked rung', () => {
    for (const s of [native, tmux, remote, null]) {
      const rung = lowestUsefulRung(s)
      // `null` has no recoverable holder, so it falls through — the invariant
      // is that whatever comes back is actionable.
      if (rung.blockedReason) {
        expect(rungsFor(s).every((r) => r.blockedReason)).toBe(true)
      }
    }
  })
})

describe('the automatic layer is described, not just toggled', () => {
  test('the auto-heal copy names the guard rails', () => {
    // The toggle is the operator's off-switch for something that takes a real
    // action unattended. The hint has to say what limits it, or turning it on
    // is an act of faith.
    const hint = RECOVERY.autoHealHint.toLowerCase()
    expect(hint).toContain('automatically')
    expect(hint).toMatch(/rate-limited|retries/)
    // The reassurance that matters most: your own Stop is never undone.
    expect(hint).toContain('stopped')
  })
})
