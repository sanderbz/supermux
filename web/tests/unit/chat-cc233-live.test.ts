/**
 * CC 2.1.233 — the live self-test, replayed.
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-08-16 the shipped sequencer was wired to a real session
 * (`GET /peek` → `refresh`, `POST /keys` → `sendKey`) and allowed to answer five
 * real dialogs. Every key that went into that pty was chosen by
 * `dialog-answer.ts`, and every frame it looked at was written down in capture
 * order: `tests/fixtures/tui/cc233/live/`, index and side-effect proofs in that
 * directory's README.
 *
 * This file replays those frames through the SAME function and asserts it still
 * chooses the same keys. That is the difference between "we ran it once and it
 * worked" and a regression test: a change to the lens, the registry or the
 * arithmetic that would have answered those five dialogs differently fails here,
 * with the capture that proves what the terminal actually showed.
 *
 * The pin is read from the live run's own log (`livePin`), not typed — and that
 * log also records `pinOverridden: false`, which is the claim the a4c and a4d
 * runs could NOT make: they had to substitute `PIN=` by hand because the CLI had
 * moved ahead of the registry.
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
import { readLens, type DialogContinuity } from '../../src/components/chat/peek-lens'
import { entryFor, type RegistryId } from '../../src/components/chat/registry'
import type { KeyName } from '../../src/lib/session-input/types'

const DIR = join(import.meta.dir, '../fixtures/tui/cc233')
const cap = (name: string) => readFileSync(join(DIR, 'live', `${name}.txt`), 'utf8')
const lensOf = (name: string, continuing?: DialogContinuity | null) =>
  readLens(cap(name), continuing)

/** The live run's own machine log. */
interface SequenceLog {
  livePin: string | null
  pinUsed: string | null
  pinOverridden: boolean
  target: number | 'escape'
  plan?: KeyName[]
  outcome: AnswerOutcome
  looks: { tag: string; footerHasTabToAmend: boolean }[]
}
const logOf = (name: string): SequenceLog =>
  JSON.parse(readFileSync(join(DIR, 'live', `${name}-sequence.json`), 'utf8'))

/** The pin, from the session's boot banner, exactly as the run resolved it. */
const PIN = readLens(readFileSync(join(DIR, '00-boot-banner.txt'), 'utf8')).bannerVersion

interface Case {
  name: string
  entryId: RegistryId
  target: number | 'escape'
  /** Every frame the live run wrote, in order. `frames[0]` is the HARNESS's own
   *  look — the one standing in for the poll frame the card was drawn from —
   *  and `frames.slice(1)` are the sequencer's own looks, which is what `replay`
   *  feeds back to it. */
  frames: readonly string[]
}

/** The five cases, with the frames in the order they were captured. */
const CASES: readonly Case[] = [
  {
    name: 'case1-bash-deny',
    entryId: 'permission.bash',
    target: 2,
    frames: [
      'case1-bash-deny-01-strict',
      'case1-bash-deny-02-strict',
      'case1-bash-deny-03-continuity',
      'case1-bash-deny-04-continuity',
      'case1-bash-deny-05-continuity',
    ],
  },
  {
    name: 'case2-write-option2',
    entryId: 'permission.write',
    target: 1,
    frames: [
      'case2-write-option2-01-strict',
      'case2-write-option2-02-strict',
      'case2-write-option2-03-continuity',
      'case2-write-option2-04-continuity',
    ],
  },
  {
    name: 'case3-bash-allow',
    entryId: 'permission.bash',
    target: 0,
    frames: [
      'case3-bash-allow-01-strict',
      'case3-bash-allow-02-strict',
      'case3-bash-allow-03-continuity',
    ],
  },
  {
    name: 'case4-plan-manual',
    entryId: 'plan.approval',
    target: 1,
    frames: [
      'case4-plan-manual-01-strict',
      'case4-plan-manual-02-strict',
      'case4-plan-manual-03-continuity',
      'case4-plan-manual-04-continuity',
    ],
  },
  {
    name: 'case5-edit-escape',
    entryId: 'permission.edit',
    target: 'escape',
    frames: [
      'case5-edit-escape-01-strict',
      'case5-edit-escape-02-strict',
      'case5-edit-escape-03-continuity',
    ],
  },
]

/** Replay one case's frames through the shipped sequencer. */
async function replay(c: Case): Promise<{ out: AnswerOutcome; sent: KeyName[] }> {
  const sent: KeyName[] = []
  const own = c.frames.slice(1)
  let i = 0
  const deps: AnswerDeps = {
    // The anchor is honoured exactly as `use-peek-lens.ts` honours it: the
    // sequencer's own looks may be relaxed, and only theirs.
    refresh: async (continuing) => lensOf(own[Math.min(i++, own.length - 1)], continuing),
    sendKey: async (k) => {
      sent.push(k)
    },
    pin: PIN,
    wait: async () => {},
  }
  const out = await answerDialog(deps, {
    entryId: c.entryId,
    target: c.target,
    key: sightingKey(lensOf(c.frames[0]).dialog!),
  })
  return { out, sent }
}

describe('cc233 — the corpus and its pin', () => {
  test('the banner pins 2.1.233 and every entry covers it', () => {
    expect(PIN).toBe('2.1.233')
    for (const c of CASES) {
      expect(entryFor(lensOf(c.frames[0]), PIN).degraded).toBe(false)
    }
  })

  test('the live run needed no version substitution', () => {
    // a4c and a4d both had to pass `PIN=` by hand. This is what "the pin is
    // current" looks like as an assertion.
    for (const c of CASES) {
      const log = logOf(c.name)
      expect(log.livePin).toBe('2.1.233')
      expect(log.pinUsed).toBe('2.1.233')
      expect(log.pinOverridden).toBe(false)
    }
  })

  test('every live case succeeded, and committed', () => {
    for (const c of CASES) {
      const { outcome } = logOf(c.name)
      expect(outcome.ok).toBe(true)
      expect(outcome.committed).toBe(true)
    }
  })
})

describe('cc233 — the replay chooses the same keys the live run sent', () => {
  for (const c of CASES) {
    test(`${c.name}: ${logOf(c.name).outcome.sent.join(', ')}`, async () => {
      const live = logOf(c.name)
      const { out, sent } = await replay(c)
      // The wire's record and the module's own record agree…
      expect(out.sent).toEqual(sent)
      // …and both agree with what actually went into the pty that afternoon.
      expect(sent).toEqual(live.outcome.sent)
      expect(out.ok).toBe(live.outcome.ok)
      expect(out.committed).toBe(live.outcome.committed)
      expect(out.effect).toBe(live.outcome.effect)
    })
  }

  test('case4 planned UP, because the caret was already past the row', () => {
    // The rule this proves: the plan is computed from where the caret IS, never
    // from an assumed default. The live caret sat on row 3 and the code chose
    // `Up` — a registry that assumed a fresh dialog would have sent `Down` and
    // committed "Tell Claude what to change" instead of "manually approve".
    const log = logOf('case4-plan-manual')
    expect(lensOf('case4-plan-manual-01-strict').dialog!.caretIndex).toBe(2)
    expect(log.plan).toEqual(['Up', 'Enter'])
    expect(log.outcome.sent).toEqual(['Up', 'Enter'])
  })
})

describe('cc233 — the two-phase fingerprint, on the live frames', () => {
  test('the mid-sequence frame reads unknown strictly and permission anchored', () => {
    // The frame that used to kill the run: caret on row 2, so CC dropped
    // `Tab to amend` from the footer. The shared poll frame still sees `unknown`
    // — nothing about the ambient reading was relaxed.
    for (const [strictFrame, anchorFrame] of [
      ['case1-bash-deny-03-continuity', 'case1-bash-deny-01-strict'],
      ['case2-write-option2-03-continuity', 'case2-write-option2-01-strict'],
    ] as const) {
      expect(cap(strictFrame)).not.toContain('Tab to amend')
      expect(lensOf(strictFrame).dialog!.family).toBe('unknown')

      const anchor = lensOf(anchorFrame).dialog!
      const anchored = lensOf(strictFrame, {
        family: 'permission',
        variant: anchor.variant,
        question: anchor.question!,
        options: anchor.options,
      })
      expect(anchored.dialog!.family).toBe('permission')
      expect(anchored.dialog!.caretIndex).toBe(1)
    }
  })

  test('the live log recorded that same split, frame by frame', () => {
    const looks = logOf('case1-bash-deny').looks
    expect(looks.map((l) => l.footerHasTabToAmend)).toEqual([true, true, false, true, false])
  })
})
