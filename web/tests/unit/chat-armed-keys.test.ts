/**
 * **Armed keys — the refusal that has to land before any automated keypress.**
 *
 * Catalog `generic.armed_keys`: "supermux must not auto-send Esc/Ctrl-C for its
 * OWN purposes while one of these armed states is showing — it would clear the
 * composer, kill agents, or exit the process", and, explicitly, it "must land
 * BEFORE, not after, any auto-key recovery".
 *
 * Two halves are asserted here and both are load-bearing:
 *
 *   1. the LENS sees the arming on the screens the catalog names, and does NOT
 *      see one in the ordinary footer hints that merely rhyme with it
 *      (`ctrl+e to explain` sits under every Bash permission dialog — a reader
 *      that called that an arming would refuse Stop on every permission screen,
 *      which is an outage wearing a safety argument);
 *   2. the REGISTRY refuses to forward into an armed family that has no explicit
 *      mapping, and forwards when — and only when — one exists. The mapping list
 *      ships empty, so the second direction is proved with a mapping the test
 *      supplies: a refusal mechanism nobody can satisfy is indistinguishable
 *      from a hard-coded `false`, and would rot the day somebody captures one.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readLens, type ArmedKey, type PeekLens } from '../../src/components/chat/peek-lens'
import {
  ARMED_MAPPINGS,
  armedFamilyOf,
  armedRefusal,
  mayForward,
  type ArmedMapping,
} from '../../src/components/chat/registry/armed'

const PTY = join(import.meta.dir, '../../../server/tests/fixtures/pty')
const TUI = join(import.meta.dir, '../fixtures/tui')
const ptyLens = (name: string) => readLens(readFileSync(join(PTY, name), 'utf8'))
const tuiLens = (name: string) => readLens(readFileSync(join(TUI, name), 'utf8'))

describe('the lens reads what the screen has armed', () => {
  test('“Esc again to clear” arms Escape, and names what the press would do', () => {
    const lens = ptyLens('armed-esc-clear.txt')
    const esc = lens.armed.find((a) => a.key === 'Escape')
    expect(esc).toBeDefined()
    expect(esc!.action).toBe('clear')
    // The line is quoted verbatim, because the whole content of the refusal is
    // a fact the user can check by looking at their own terminal.
    expect(esc!.text).toContain('Esc again to clear')
  })

  test('the paste-undo hint rides along — the screen has an undo buffer', () => {
    const lens = ptyLens('armed-esc-clear.txt')
    const paste = lens.armed.find((a) => /ctrl\+y/i.test(a.token))
    expect(paste).toBeDefined()
    expect(paste!.action).toBe('paste deleted text')
    // No allowlisted name — and that is not a pass. See the `key: null` note on
    // `ArmedKey`: an unmappable token still proves the screen redefined its
    // keyboard, and the refusal is by screen.
    expect(paste!.key).toBeNull()
  })

  test('“Press Ctrl-C again to exit” arms C-c — both consequences, separately', () => {
    const lens = ptyLens('armed-ctrl-c-exit.txt')
    const actions = lens.armed.map((a) => a.action)
    expect(actions).toContain('exit')
    expect(actions).toContain('stop background agents')
    expect(lens.armed.every((a) => a.key === 'C-c')).toBe(true)
  })

  test('an ordinary footer hint is NOT an arming', () => {
    // `Esc to cancel · Tab to amend · ctrl+e to explain` — the permission
    // dialog's own footer, on every capture in the suite. Nothing here is a
    // pending second press, and a reader that said otherwise would disable Stop
    // for the whole life of every dialog.
    for (const f of ['perm-bash.txt', 'perm-edit.txt', 'plan-approval.txt']) {
      expect(tuiLens(f).armed).toEqual([])
    }
    expect(ptyLens('idle.txt').armed).toEqual([])
  })

  test('an arming that has scrolled out of the live tail is history', () => {
    // CC times the arming out and redraws; a hint 20 rows up is a key that is
    // no longer armed, and refusing forever on history is its own outage.
    const stale = `${'  Esc again to clear\n'}${'● still working\n'.repeat(10)}`
    expect(readLens(stale).armed).toEqual([])
  })
})

describe('the registry refuses to forward into an armed family', () => {
  const armedEsc: ArmedKey = {
    token: 'Esc',
    key: 'Escape',
    action: 'clear',
    text: 'Esc again to clear · Ctrl+Y to paste deleted text',
  }
  const composerScreen = { armed: [armedEsc], dialog: null } as Pick<
    PeekLens,
    'armed' | 'dialog'
  >

  test('the shipped mapping list is empty — nothing is licensed yet', () => {
    // The rule this file exists to enforce: an armed screen nobody has watched
    // is a screen this app presses nothing into. When somebody captures one,
    // this expectation is what makes them come here and say so.
    expect(ARMED_MAPPINGS).toEqual([])
  })

  test('an armed screen with no mapping refuses the key', () => {
    const refusal = armedRefusal(composerScreen, 'Escape')
    expect(refusal).not.toBeNull()
    expect(refusal!.family).toBe('composer')
    expect(refusal!.reason).toContain('Esc again to clear')
    expect(mayForward(composerScreen, 'Escape')).toBe(false)
  })

  test('it refuses a DIFFERENT key too — the refusal is by screen, not by key', () => {
    // `Ctrl+Y to paste deleted text` arms a key this app cannot even name. The
    // honest reading of "I cannot tell which key this screen redefined" is not
    // "so mine is fine".
    expect(mayForward(composerScreen, 'Enter')).toBe(false)
    expect(mayForward(composerScreen, 'C-c')).toBe(false)
  })

  test('a clear screen forwards everything', () => {
    expect(armedRefusal({ armed: [], dialog: null }, 'Escape')).toBeNull()
  })

  test('an explicit mapping — and only a matching one — licenses the send', () => {
    const mapping: ArmedMapping = {
      family: 'composer',
      token: /^esc$/i,
      action: /^clear$/,
      key: 'Escape',
      evidence: 'test-only mapping: proves the licence path is reachable',
    }
    expect(mayForward(composerScreen, 'Escape', [mapping])).toBe(true)
    // Every field of the claim is part of it: the same mapping does not license
    // a different key, and a mapping written for another family does not carry
    // over — `Press Esc again to exit` on the trust gate is the same token with
    // a different consequence (#75649).
    expect(mayForward(composerScreen, 'C-c', [mapping])).toBe(false)
    expect(mayForward(composerScreen, 'Escape', [{ ...mapping, family: 'startup' }])).toBe(
      false,
    )
    expect(mayForward(composerScreen, 'Escape', [{ ...mapping, action: /^exit$/ }])).toBe(
      false,
    )
  })

  test('the family is read off the dialog when one is up', () => {
    const lens = ptyLens('trust-folder.txt')
    expect(armedFamilyOf(lens)).toBe('startup')
    expect(armedFamilyOf({ dialog: null })).toBe('composer')
  })
})
