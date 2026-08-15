/**
 * The two-phase fingerprint, against the A4c LIVE captures (fase A4 T7 follow-up).
 * ─────────────────────────────────────────────────────────────────────────────
 * Claude Code 2.1.232 redraws the permission FOOTER as the caret moves:
 * `Tab to amend` is printed on rows 1 and 3 and dropped on row 2. A single
 * strict fingerprint therefore aborted every answer that had to step onto row 2
 * — options 2 and 3 of every permission dialog — after one `Down` had already
 * gone, leaving the caret parked on the most permissive row.
 *
 * The fix is a SPLIT, not a relaxation, and this file is where both halves are
 * held:
 *
 *   SIGHTING (phase 1)    unchanged and strict, `Tab to amend` included. The
 *                         tests below that matter most are the ones asserting
 *                         a footer-less prompt is STILL `family: unknown` —
 *                         with an anchor and without one.
 *   CONTINUITY (phase 2)  offered only to a dialog already sighted strictly, and
 *                         only to that dialog: same question, same option rows
 *                         in the same order, same title, section rule present.
 *                         Footer excluded, because the evidence says the footer
 *                         belongs to the caret.
 *
 * Every frame here is a real capture of a real session answering a real dialog;
 * provenance and the two derived files are in `tests/fixtures/tui/a4c/README.md`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  answerDialog,
  sightingKey,
  type AnswerDeps,
  type AnswerOutcome,
} from '../../src/components/chat/dialog-answer'
import {
  continuityOf,
  readLens,
  type DialogContinuity,
} from '../../src/components/chat/peek-lens'
import { entryFor, keyPlan } from '../../src/components/chat/registry'
import type { KeyName } from '../../src/lib/session-input/types'
import type { RegistryId } from '../../src/components/chat/registry'

const DIR = join(import.meta.dir, '../fixtures/tui/a4c')
const cap = (name: string) => readFileSync(join(DIR, `${name}.txt`), 'utf8')
const lensOf = (name: string, continuing?: DialogContinuity | null) =>
  readLens(cap(name), continuing)

/** The version this whole corpus was captured on — read from the banner rather
 *  than typed, so a fixture swap cannot quietly re-pin the suite. */
const PIN = readLens(cap('00-boot-banner')).bannerVersion

/** The anchor a sequence would carry, taken from a STRICT reading. */
const anchorOf = (name: string): DialogContinuity => {
  const lens = lensOf(name)
  return continuityOf(lens.dialog!)!
}

/**
 * Replay a whole answer against the captured frames, in capture order.
 *
 * `refresh` is the only thing the sequencer can see, and it honours the anchor
 * exactly as `use-peek-lens.ts` does — so what this asserts is the shipped
 * arithmetic, not a re-implementation of it.
 */
async function replay(
  frames: readonly string[],
  entryId: RegistryId,
  target: number | 'escape',
): Promise<AnswerOutcome> {
  const sent: KeyName[] = []
  let i = 0
  const deps: AnswerDeps = {
    refresh: async (continuing) =>
      lensOf(frames[Math.min(i++, frames.length - 1)], continuing),
    sendKey: async (k) => {
      sent.push(k)
    },
    pin: PIN,
    wait: async () => {},
  }
  const out = await answerDialog(deps, {
    entryId,
    target,
    key: sightingKey(lensOf(frames[0]).dialog!),
  })
  // `sent` on the outcome is the module's own record; this is the wire's.
  expect(out.sent).toEqual(sent)
  return out
}

describe('a4c — the corpus itself', () => {
  test('the banner pins 2.1.232, which is what the registry now covers', () => {
    expect(PIN).toBe('2.1.232')
    expect(entryFor(lensOf('case1-bash-deny-1-before'), PIN).degraded).toBe(false)
  })

  test('the footer really does move with the caret', () => {
    // The finding, asserted rather than described. If CC stops doing this the
    // test fails and somebody reads the fixture before the code changes.
    expect(cap('case1-bash-deny-1-before')).toContain('Tab to amend')
    expect(cap('case1-bash-deny-3-after-Down2')).toContain('Tab to amend')
    expect(cap('case1-bash-deny-2-after-Down1')).not.toContain('Tab to amend')
    expect(cap('case3-write-option2-2-after-Down1')).not.toContain('Tab to amend')
    expect(cap('case4b-edit-deny-2-after-Down1')).not.toContain('Tab to amend')
  })
})

describe('phase 1 — the sighting stays strict', () => {
  test('a Read/WebFetch-shaped prompt is family:unknown, with no anchor', () => {
    // No `Tab to amend` — nothing to amend — so it is not in an act-on family,
    // and the registry has nothing to press.
    const lens = lensOf('read-shaped-no-amend-derived')
    expect(lens.dialog?.family).toBe('unknown')
    expect(entryFor(lens, PIN).entry).toBeNull()
  })

  test('…and it is STILL unknown when a permission anchor is offered', () => {
    // Continuity is not a back door: the anchor belongs to another dialog, and
    // the question line and option rows say so.
    const lens = lensOf('read-shaped-no-amend-derived', anchorOf('case1-bash-deny-1-before'))
    expect(lens.dialog?.family).toBe('unknown')
    expect(entryFor(lens, PIN).entry).toBeNull()
  })

  test('an unfixtured live modal is unknown — the auto-mode nag', () => {
    const lens = lensOf('00b-unknown-family-auto-mode-nag')
    expect(lens.dialog?.family).toBe('unknown')
  })

  test('the row-2 frame on its own is unknown — the blocker, unchanged', () => {
    // This is the reading the ambient poll, the composer gate and the Attention
    // card still get. Nothing about the surface was relaxed.
    for (const f of [
      'case1-bash-deny-2-after-Down1',
      'case3-write-option2-2-after-Down1',
      'case4b-edit-deny-2-after-Down1',
    ]) {
      expect(lensOf(f).dialog?.family).toBe('unknown')
      expect(entryFor(lensOf(f), PIN).entry).toBeNull()
    }
  })
})

describe('phase 2 — continuity, and what still aborts', () => {
  test('the same dialog with the caret one row on is recognised', () => {
    const lens = lensOf('case1-bash-deny-2-after-Down1', anchorOf('case1-bash-deny-1-before'))
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.dialog?.variant).toBe('bash')
    expect(lens.dialog?.caretIndex).toBe(1)
    // The identity the sequencer compares is unchanged by the relaxation.
    expect(sightingKey(lens.dialog!)).toBe(
      sightingKey(lensOf('case1-bash-deny-1-before').dialog!),
    )
  })

  test('the anchor is caret-invariant by construction', () => {
    const before = anchorOf('case1-bash-deny-1-before')
    const after = continuityOf(
      lensOf('case1-bash-deny-3-after-Down2').dialog!,
    )
    expect(after).toEqual(before)
    expect(before.question).toBe('Do you want to proceed?')
  })

  test('an option LIST that changed is refused, anchor or not', () => {
    const lens = lensOf(
      'case1-bash-deny-2-mutated-rows-derived',
      anchorOf('case1-bash-deny-1-before'),
    )
    expect(lens.dialog?.family).toBe('unknown')
  })

  test('a different dialog cannot borrow an anchor', () => {
    // The write dialog's own frames, read against the bash anchor: the question
    // names its target, so they are not the same screen.
    const lens = lensOf('case3-write-option2-2-after-Down1', anchorOf('case1-bash-deny-1-before'))
    expect(lens.dialog?.family).toBe('unknown')
  })

  test('an unknown sighting has no anchor to give', () => {
    expect(continuityOf(lensOf('00b-unknown-family-auto-mode-nag').dialog!)).toBeNull()
  })
})

describe('the sequencer, replayed on the live frames', () => {
  test('case 1 — bash deny runs [Down, Down, Enter] to completion', async () => {
    expect(keyPlan(0, 2)).toEqual(['Down', 'Down', 'Enter'])
    const out = await replay(
      [
        'case1-bash-deny-1-before',
        'case1-bash-deny-2-after-Down1',
        'case1-bash-deny-3-after-Down2',
        'case1-bash-deny-4-dismiss1',
      ],
      'permission.bash',
      2,
    )
    expect(out).toMatchObject({
      ok: true,
      sent: ['Down', 'Down', 'Enter'],
      committed: true,
      effect: 'deny',
    })
    // The live session agreed: the command did not run.
    expect(cap('case1-bash-deny-4-dismiss1')).not.toContain('Do you want to proceed?')
  })

  test('case 3 — write option 2 runs [Down, Enter] to completion', async () => {
    const out = await replay(
      [
        'case3-write-option2-1-before',
        'case3-write-option2-2-after-Down1',
        'case3-write-option2-3-dismiss1',
      ],
      'permission.write',
      1,
    )
    expect(out).toMatchObject({
      ok: true,
      sent: ['Down', 'Enter'],
      committed: true,
      // Captured live for the first time by this run: the file was written AND
      // the session flipped to `⏵⏵ accept edits on`.
      effect: 'accept-session',
    })
  })

  test('case 4b — edit deny runs [Down, Down, Enter] to completion', async () => {
    const out = await replay(
      [
        'case4b-edit-deny-1-before',
        'case4b-edit-deny-2-after-Down1',
        'case4b-edit-deny-3-after-Down2',
        'case4b-edit-deny-4-dismiss1',
      ],
      'permission.edit',
      2,
    )
    expect(out).toMatchObject({ ok: true, sent: ['Down', 'Down', 'Enter'], effect: 'deny' })
  })

  test('case 4 — the plan dialog is unaffected, as it always was', async () => {
    const out = await replay(
      [
        'case4-plan-manual-1-before',
        'case4-plan-manual-2-after-Down1',
        'case4-plan-manual-3-dismiss1',
      ],
      'plan.approval',
      1,
    )
    expect(out).toMatchObject({ ok: true, sent: ['Down', 'Enter'], effect: 'accept' })
  })

  test('cases 2 and 5 — the no-navigation paths still land', async () => {
    const allow = await replay(
      ['case2-bash-allow-1-before', 'case2-bash-allow-2-dismiss1'],
      'permission.bash',
      0,
    )
    expect(allow).toMatchObject({ ok: true, sent: ['Enter'], effect: 'accept' })

    const escape = await replay(
      ['case5-escape-1-before', 'case5-escape-2-dismiss1'],
      'permission.bash',
      'escape',
    )
    expect(escape).toMatchObject({ ok: true, sent: ['Escape'], effect: 'feedback' })
  })

  test('a mutated option list mid-sequence still aborts, with NO Enter', async () => {
    // The abort the safety wave verified, preserved: one `Down` has gone, the
    // rows changed under it, and the commit never happens.
    const out = await replay(
      [
        'case1-bash-deny-1-before',
        'case1-bash-deny-2-mutated-rows-derived',
        'case1-bash-deny-4-dismiss1',
      ],
      'permission.bash',
      2,
    )
    expect(out).toMatchObject({
      ok: false,
      sent: ['Down'],
      committed: false,
      failure: 'changed',
      attention: 'dialog-unmapped',
    })
    expect(out.detail).toBeTruthy()
  })

  test('a dialog that SURVIVES the commit is still-open, not a false success', async () => {
    // Without the anchor on the dismissal look, a survivor sitting on row 2
    // reads as `unknown` — a different sighting key — and the sequence would
    // report success on the one frame where being wrong is worst.
    const out = await replay(
      [
        'case1-bash-deny-1-before',
        'case1-bash-deny-2-after-Down1',
        'case1-bash-deny-3-after-Down2',
        // the commit did not take: the same dialog, caret still on row 2
        'case1-bash-deny-2-after-Down1',
      ],
      'permission.bash',
      2,
    )
    expect(out).toMatchObject({
      ok: false,
      sent: ['Down', 'Down', 'Enter'],
      committed: true,
      failure: 'still-open',
    })
  })
})

describe('the composer ghost (a4c finding 3)', () => {
  test('with the SGR channel, a dim predicted prompt is not a draft', () => {
    const lens = lensOf('composer-ghost-ansi')
    expect(lens.composerDraft).toBeNull()
    expect(lens.composerDraftVerified).toBe(true)
  })

  test('an empty prompt in the same channel reads empty', () => {
    const lens = lensOf('composer-empty-ansi')
    expect(lens.composerDraft).toBeNull()
    expect(lens.composerDraftVerified).toBe(true)
  })

  test('a real typed draft survives the dim strip', () => {
    // The A1 fixture, ANSI-preserved: `half a thought` carries no SGR 2, so the
    // guard still has something to refuse on.
    const lens = readLens(
      readFileSync(join(DIR, '../composer-draft-ansi.txt'), 'utf8'),
    )
    expect(lens.composerDraft).toBe('half a thought')
    expect(lens.composerDraftVerified).toBe(true)
  })

  test('on a PLAIN capture the same ghost reads as a draft, marked unverified', () => {
    // The old-server fallback: the text is reported (the guard is not blinded)
    // and the reading admits it cannot tell whose text it is.
    const lens = lensOf('00c-cleared')
    expect(lens.composerDraft).toContain('Run exactly this one Bash command')
    expect(lens.composerDraftVerified).toBe(false)
  })
})
