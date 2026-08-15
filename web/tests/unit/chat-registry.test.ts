// The modal registry (fase A4 T6) — read against the same a0 captures the
// registry's claims came from. A test here that stops passing means either CC
// changed or a claim was widened without a capture; both are things somebody has
// to look at before a key is pressed into somebody's session.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { readLens, type DialogSighting } from '../../src/components/chat/peek-lens'
import {
  ENTRIES,
  entryById,
  entryFor,
  keyPlan,
  navigationSteps,
  optionLabel,
  pinFor,
  type RegistryEntry,
  type RegistryId,
} from '../../src/components/chat/registry'

const DIR = join(import.meta.dir, '../fixtures/tui')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const lensOf = (name: string) => readLens(read(name))
/** The 2.1.232 live self-test corpus — provenance in `../fixtures/tui/a4c/README.md`. */
const a4cOf = (name: string) => readLens(readFileSync(join(DIR, 'a4c', name), 'utf8'))

/** Every act-on claim in the registry is backed by one of these files — the
 *  provenance of each is in `tests/fixtures/tui/README.md`. */
const FIXTURES: Record<RegistryId, string> = {
  'permission.bash': 'perm-bash.txt',
  'permission.edit': 'perm-edit.txt',
  'permission.write': 'perm-write.txt',
  'plan.approval': 'plan-approval.txt',
}

const pinned = (entry: RegistryEntry) => entry.verifiedVersions[0]

describe('registry — what may be acted on, and what may not', () => {
  test('bash option 2 is rendered but never actionable', () => {
    // a0 §3: "executes, but persistence NOT FOUND … inconclusive". A grant whose
    // scope is unknown is not one this app hands out.
    const match = entryFor(lensOf('perm-bash.txt'), '2.1.231')
    expect(match.degraded).toBe(false)
    const o = match.entry!.options[1]
    expect(o.actOn).toBe(false)
    expect(o.disabledReason).toMatch(/unverified/i)
    // Rendered: the words are still there to read.
    expect(o.label.length).toBeGreaterThan(0)
  })

  test('bash options 1 and 3 ARE actionable (execute / cancel, both verified)', () => {
    const opts = entryFor(lensOf('perm-bash.txt'), '2.1.227').entry!.options
    expect(opts[0]).toMatchObject({ actOn: true, effect: 'accept' })
    expect(opts[2]).toMatchObject({ actOn: true, effect: 'deny' })
  })

  test('edit option 2 IS actionable (BTab-verified)', () => {
    // a0 §3: "BTab acts as option 2 on Edit/Write dialogs (file written +
    // `⏵⏵ accept edits on` — verified)."
    const o = entryFor(lensOf('perm-edit.txt'), '2.1.231').entry!.options[1]
    expect(o.actOn).toBe(true)
    expect(o.effect).toBe('accept-session')
    expect(o.disabledReason).toBeUndefined()
  })

  test('write option 2 IS actionable — the same row, same verification', () => {
    const o = entryFor(lensOf('perm-write.txt'), '2.1.227').entry!.options[1]
    expect(o.actOn).toBe(true)
    expect(o.effect).toBe('accept-session')
  })

  test('a permission Esc IS actionable, and it denies', () => {
    // a0 §3: Escape → `Interrupted · What should Claude do instead?` + composer
    // focus, artifact absent. It is the free-text branch's first half.
    const esc = entryFor(lensOf('perm-bash.txt'), '2.1.231').entry!.escape
    expect(esc.actOn).toBe(true)
    expect(esc.effect).toBe('feedback')
  })

  test('plan Esc is not actionable in v1', () => {
    // a0 §3, verbatim: "Esc: UNVERIFIED (skipped for interference risk; expected
    // ≈ option 3) — A4 self-test must capture it before the registry maps it."
    const esc = entryFor(lensOf('plan-approval.txt'), '2.1.231').entry!.escape
    expect(esc.actOn).toBe(false)
    expect(esc.disabledReason).toMatch(/captured/i)
  })

  test('the plan card carries the real 2.1.231 labels, all three act-on', () => {
    const entry = entryFor(lensOf('plan-approval.txt'), '2.1.231').entry!
    expect(entry.options.map((o) => o.label)).toEqual([
      'Yes, and use auto mode',
      'Yes, manually approve edits',
      'Tell Claude what to change',
    ])
    expect(entry.options.every((o) => o.actOn)).toBe(true)
    expect(entry.options.map((o) => o.effect)).toEqual([
      'accept-session', // ⏵⏵ auto mode on — grants everything that follows
      'accept',
      'feedback',
    ])
  })

  test('every act-on option matches its own fixture, row for row', () => {
    // The meta-rule from the plan: no option is enabled without a fixture. This
    // is that rule, executable — an entry whose rows drifted cannot stay green.
    for (const entry of ENTRIES) {
      const lens = lensOf(FIXTURES[entry.id])
      const match = entryFor(lens, pinned(entry))
      expect(match.degraded).toBe(false)
      for (const o of match.entry!.options.filter((x) => x.actOn)) {
        expect(o.rowPattern.test(lens.dialog!.options[o.tuiIndex])).toBe(true)
      }
    }
  })

  test('every disabled option says why, and no enabled one pretends to', () => {
    for (const entry of ENTRIES) {
      for (const o of [...entry.options, entry.escape]) {
        if (o.actOn) expect(o.disabledReason).toBeUndefined()
        else expect((o.disabledReason ?? '').length).toBeGreaterThan(20)
      }
    }
  })
})

describe('registry — the version pin', () => {
  test('an unpinned version hard-disables every option', () => {
    const r = entryFor(lensOf('perm-bash.txt'), '2.2.0')
    expect(r.degraded).toBe(true)
    expect(r.attention).toBe('registry-version-mismatch')
    expect(r.entry!.options.every((o) => !o.actOn)).toBe(true)
    expect(r.entry!.escape.actOn).toBe(false)
    expect(r.entry!.options[0].disabledReason).toContain('2.2.0')
  })

  test('an unreadable banner is a mismatch, not a pass', () => {
    // The banner scrolls off a 60-line window; `null` means "we could not read
    // which Claude Code this is", which is strictly less knowledge than a
    // version we have not checked — it must not be the permissive branch.
    const r = entryFor(lensOf('perm-bash.txt'), null)
    expect(r.degraded).toBe(true)
    expect(r.attention).toBe('registry-version-mismatch')
    expect(r.entry!.options.every((o) => !o.actOn)).toBe(true)
  })

  test('the pin is the boot banner, and nothing else', () => {
    expect(pinFor({ bannerVersion: '2.1.232' })).toBe('2.1.232')
    expect(pinFor({ bannerVersion: null })).toBeNull()
    expect(pinFor({ bannerVersion: '  ' })).toBeNull()
    // The version a `/peek` of a running dialog can see is null (the banner is
    // long gone) — which is exactly why `use-peek-lens` caches a deep read.
    expect(pinFor(lensOf('perm-bash.txt'))).toBeNull()
  })

  test('each entry pins the versions its own capture proves', () => {
    // 2.1.232 is on all four because the A4c self-test drove all four against
    // it, end to end, with the side-effect proof recorded per case
    // (`tests/fixtures/tui/a4c/README.md`). The older numbers are a0's, and each
    // variant still carries exactly the ones its own bytes prove.
    expect(entryById('permission.bash')!.verifiedVersions).toEqual([
      '2.1.227',
      '2.1.231',
      '2.1.232',
    ])
    expect(entryById('permission.edit')!.verifiedVersions).toEqual(['2.1.231', '2.1.232'])
    expect(entryById('permission.write')!.verifiedVersions).toEqual(['2.1.227', '2.1.232'])
    expect(entryById('plan.approval')!.verifiedVersions).toEqual(['2.1.231', '2.1.232'])
  })

  test('the live 2.1.232 captures are ACT-ON, not merely rendered', () => {
    // The point of widening the pin: before this, every a4c frame came back
    // `registry-version-mismatch` with every option inert, so the answer path
    // was inert on the CLI actually installed.
    for (const [file, id] of [
      ['case1-bash-deny-1-before.txt', 'permission.bash'],
      ['case3-write-option2-1-before.txt', 'permission.write'],
      ['case4b-edit-deny-1-before.txt', 'permission.edit'],
      ['case4-plan-manual-1-before.txt', 'plan.approval'],
    ] as const) {
      const m = entryFor(a4cOf(file), '2.1.232')
      expect(m.entry?.id).toBe(id)
      expect(m.degraded).toBe(false)
      expect(m.attention).toBeNull()
    }
  })
})

describe('registry — sightings it refuses', () => {
  test('no dialog on screen is not a degrade', () => {
    const r = entryFor(lensOf('composer-idle.txt'), '2.1.231')
    expect(r).toEqual({ entry: null, degraded: false, attention: null })
  })

  test('a permission whose variant is unreadable is unmapped, not guessed', () => {
    // The three variants differ in what option 2 grants, so "some permission
    // dialog" is not enough to press a key into.
    const sighting = { ...lensOf('perm-bash.txt').dialog! }
    delete sighting.variant
    const r = entryFor({ dialog: sighting }, '2.1.231')
    expect(r.entry).toBeNull()
    expect(r.attention).toBe('dialog-unmapped')
  })

  test('a row that no longer says what it said disables the card', () => {
    const dialog = lensOf('perm-bash.txt').dialog!
    const drifted: DialogSighting = {
      ...dialog,
      options: [dialog.options[0], dialog.options[1], 'No, and tell Claude why'],
    }
    const r = entryFor({ dialog: drifted }, '2.1.231')
    expect(r.degraded).toBe(true)
    expect(r.attention).toBe('dialog-unmapped')
    expect(r.entry!.options.every((o) => !o.actOn)).toBe(true)
  })

  test('a list that gained a row disables the card', () => {
    // The failure that turns "No" into "Yes, and always allow": counting alone
    // would still line up if only the tail moved.
    const dialog = lensOf('perm-bash.txt').dialog!
    const r = entryFor(
      { dialog: { ...dialog, options: ['Yes', ...dialog.options] } },
      '2.1.231',
    )
    expect(r.degraded).toBe(true)
    expect(r.entry!.options.every((o) => !o.actOn)).toBe(true)
  })

  test('the 52-col wrap changes nothing — the same card, act-on', () => {
    expect(entryFor(lensOf('perm-bash-52col-derived.txt'), '2.1.227')).toEqual(
      entryFor(lensOf('perm-bash.txt'), '2.1.227'),
    )
  })
})

describe('keyPlan — navigation, never digits', () => {
  test('keyPlan from caret 0 to 2', () => {
    expect(keyPlan(0, 2)).toEqual(['Down', 'Down', 'Enter'])
  })

  test('keyPlan upward uses Up', () => {
    // No evidence CC's list wraps, so `Up` — never `Down` × (N−1).
    expect(keyPlan(2, 0)).toEqual(['Up', 'Up', 'Enter'])
  })

  test('the caret already on the row just commits', () => {
    expect(keyPlan(1, 1)).toEqual(['Enter'])
  })

  test('keyPlan contains no digit, ever', () => {
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) {
        expect(keyPlan(a, b).some((k) => /^\d$/.test(k))).toBe(false)
      }
    }
  })

  test('the whole registry, walked end to end, sends only navigation and Enter', () => {
    // Every reachable (caret, option) pair on every entry — the property that
    // matters is not "keyPlan is careful" but "nothing this registry can ask for
    // is unsendable": every key below is in KEY_ALLOWLIST.
    const allowed = new Set(['Up', 'Down', 'Enter'])
    for (const entry of ENTRIES) {
      for (let caret = 0; caret < entry.options.length; caret++) {
        for (const o of entry.options) {
          const plan = keyPlan(caret, o.tuiIndex)
          expect(plan.length).toBeGreaterThan(0)
          expect(plan.every((k) => allowed.has(k))).toBe(true)
          expect(plan[plan.length - 1]).toBe('Enter')
          expect(navigationSteps(plan)).toBe(Math.abs(o.tuiIndex - caret))
        }
      }
    }
  })

  test('a refusal carries no Enter, and cannot be counted into one', () => {
    // `[]` is T7's "refuse". `navigationSteps` cannot tell it from a caret that
    // is already on the row (both 0), so a loop that counts and then presses its
    // OWN Enter would commit the option under the caret — on a permission dialog
    // that runs the command. The keys to send are the ones in the array.
    const refused = keyPlan(0, 9_999)
    expect(refused).toEqual([])
    expect(refused.includes('Enter')).toBe(false)
    expect(navigationSteps(refused)).toBe(navigationSteps(keyPlan(1, 1)))
  })

  test('nonsense in, nothing out — a refusal, not a throw', () => {
    // T7 reads `[]` as "refuse"; a throw here would take the Attention card down
    // with the card it is supposed to explain.
    expect(keyPlan(-1, 0)).toEqual([])
    expect(keyPlan(0, -1)).toEqual([])
    expect(keyPlan(0.5, 2)).toEqual([])
    expect(keyPlan(Number.NaN, 1)).toEqual([])
    expect(keyPlan(0, 9_999)).toEqual([])
  })

  test('a moved caret is planned from where it actually is', () => {
    // `perm-bash-caret2.txt` is the shape a0 verified after Down,Down.
    const caret = lensOf('perm-bash-caret2.txt').dialog!.caretIndex!
    expect(caret).toBe(2)
    expect(keyPlan(caret, 0)).toEqual(['Up', 'Up', 'Enter'])
  })
})

describe('optionLabel — the live row wins', () => {
  test('the sighted row is preferred, so a grant names what it grants', () => {
    const lens = lensOf('perm-bash.txt')
    const entry = entryFor(lens, '2.1.231').entry!
    expect(optionLabel(entry.options[1], lens.dialog)).toBe(
      'Yes, and always allow access to tmp/ from this project',
    )
  })

  test('without a sighting it falls back to the registry’s stable words', () => {
    const entry = entryById('permission.bash')!
    expect(optionLabel(entry.options[1])).toBe('Yes, and always allow this kind of command')
    expect(optionLabel(entry.options[1], null)).toBe(
      'Yes, and always allow this kind of command',
    )
  })

  test('the folded shift+tab sub-hint never reaches the card', () => {
    // The lens folds a sub-hint into its option on purpose (it cannot tell one
    // from a 52-col wrap). It must not survive into the words a human reads:
    // `BTab` is not a key chat sends, and on Edit/Write a0 verified it acts as
    // option 2 — so the hint under option 3 advertises the opposite answer.
    const edit = lensOf('perm-edit.txt')
    expect(edit.dialog!.options[1]).toContain('shift+tab')
    expect(optionLabel(entryById('permission.edit')!.options[1], edit.dialog)).toBe(
      'Yes, allow all edits during this session',
    )

    const plan = lensOf('plan-approval.txt')
    expect(plan.dialog!.options[2]).toContain('shift+tab')
    expect(optionLabel(entryById('plan.approval')!.options[2], plan.dialog)).toBe(
      'Tell Claude what to change',
    )
  })

  test('no option label names a key this app cannot send', () => {
    for (const entry of ENTRIES) {
      const lens = lensOf(FIXTURES[entry.id])
      for (const o of entry.options) {
        expect(optionLabel(o, lens.dialog)).not.toMatch(/shift\+tab|ctrl\+[a-z]/i)
      }
    }
  })

  test('a row that does not match the pattern is not shown as that option', () => {
    const entry = entryById('permission.bash')!
    const drifted = { ...lensOf('perm-bash.txt').dialog!, options: ['Yes', 'Delete it all', 'No'] }
    expect(optionLabel(entry.options[1], drifted)).toBe(
      'Yes, and always allow this kind of command',
    )
  })
})
