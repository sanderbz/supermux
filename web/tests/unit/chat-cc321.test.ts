/**
 * CC 2.1.32x — the fourth live re-verification (2026-11-25), as tests.
 *
 * Evidence: `tests/fixtures/tui/cc321/README.md`. Every version below has its own
 * captures (caret on each row) and its own live run, in which `answerDialog()`
 * chose every key against a real Claude Code of that version. This file reads
 * those bytes; it never states a row the corpus does not show.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  answerDialog,
  sightingKey,
  type AnswerDeps,
  type AnswerOutcome,
} from '../../src/components/chat/dialog-answer'
import { continuityOf, readLens, type DialogContinuity } from '../../src/components/chat/peek-lens'
import { entryFor, pinFor, type RegistryId } from '../../src/components/chat/registry'
import type { KeyName } from '../../src/lib/session-input/types'

const ROOT = join(import.meta.dir, '../fixtures/tui/cc321')

/** version → its corpus directory. 2.1.321 is the root of the corpus. */
const CORPORA: Record<string, string> = {
  '2.1.321': ROOT,
  '2.1.322': join(ROOT, 'v322'),
  '2.1.325': join(ROOT, 'v325'),
  '2.1.326': join(ROOT, 'v326'),
  '2.1.327': join(ROOT, 'v327'),
  '2.1.329': join(ROOT, 'v329'),
  '2.1.331': join(ROOT, 'v331'),
}
const VERSIONS = Object.keys(CORPORA).filter((v) => existsSync(CORPORA[v]))

const lensAt = (dir: string, file: string, continuing?: DialogContinuity | null) =>
  readLens(readFileSync(join(dir, file), 'utf8'), continuing)
const capturesIn = (dir: string, re: RegExp) =>
  readdirSync(dir).filter((f) => re.test(f)).sort()

/** How the app reads a capture. Row 1 is read STRICT, like the poll frame the
 *  card is drawn from. Any other caret position is only ever seen mid-sequence,
 *  and Claude Code drops `Tab to amend` from the footer while the caret is off
 *  row 1 (a4c, cc233, and again here), so the sequencer reads it ANCHORED on the
 *  row-1 sighting of the same dialog — exactly what `answerDialog` does. */
const appLens = (dir: string, file: string) => {
  const m = /^(.*-caret)(\d)\.txt$/.exec(file)
  if (!m || m[2] === '1') return lensAt(dir, file)
  const first = lensAt(dir, `${m[1]}1.txt`).dialog
  return lensAt(dir, file, first ? continuityOf(first) : null)
}

/** The act-on mask of a card, row by row (`1` = a key may be pressed). */
const mask = (dir: string, file: string, pin: string | null) => {
  const m = entryFor(appLens(dir, file), pin)
  return { m, bits: m.entry?.options.map((o) => (o.actOn ? '1' : '0')).join('') }
}

describe('cc321 — the corpus pins what it says', () => {
  test('there is a corpus for 2.1.321 and 2.1.325 at least', () => {
    expect(VERSIONS).toContain('2.1.321')
    expect(VERSIONS).toContain('2.1.325')
  })

  for (const v of VERSIONS) {
    test(`${v}: the boot banner IS the pin`, () => {
      expect(pinFor(lensAt(CORPORA[v], '00-boot-banner.txt'))).toBe(v)
    })
  }
})

describe('cc321 — the four-row Bash dialog (auto mode available)', () => {
  for (const v of VERSIONS) {
    const dir = CORPORA[v]
    test(`${v}: every Bash capture is the four-row card, Yes and No act-on`, () => {
      const files = capturesIn(dir, /^0[1-7]-bash-.*caret\d\.txt$/)
      expect(files.length).toBeGreaterThanOrEqual(3)
      for (const f of files) {
        const lens = appLens(dir, f)
        expect(lens.dialog?.options).toHaveLength(4)
        expect(lens.dialog?.options[3]).toBe('No')
        const { m, bits } = mask(dir, f, v)
        expect(m.degraded).toBe(false)
        expect(m.entry?.id).toBe('permission.bash')
        expect(bits).toBe('1001')
      }
    })

    test(`${v}: the caret the lens reads is the row the file was captured on`, () => {
      for (const f of capturesIn(dir, /caret\d\.txt$/)) {
        const n = Number(/caret(\d)\.txt$/.exec(f)![1])
        expect(appLens(dir, f).dialog?.caretIndex).toBe(n - 1)
      }
    })
  }

  test('off row 1 the strict read does not claim the dialog — only the anchored one does', () => {
    expect(lensAt(ROOT, '01-bash-access-caret2.txt').dialog?.family).not.toBe('permission')
    expect(appLens(ROOT, '01-bash-access-caret2.txt').dialog?.family).toBe('permission')
  })

  test('the auto-mode row is drawn, never pressed, and says why', () => {
    const { m } = mask(ROOT, '01-bash-access-caret1.txt', '2.1.321')
    const auto = m.entry!.options[2]
    expect(auto.actOn).toBe(false)
    expect(auto.disabledReason).toMatch(/auto mode/)
    expect(auto.rowPattern.test('Yes, and switch to auto mode · auto mode handles these prompts for you')).toBe(true)
  })

  test('under a 2.1.233 pin the same four rows are refused, not guessed', () => {
    const m = entryFor(lensAt(ROOT, '01-bash-access-caret1.txt'), '2.1.233')
    expect(m.degraded).toBe(true)
    expect(m.entry!.options.every((o) => !o.actOn)).toBe(true)
  })

  test('a version nobody captured is still refused', () => {
    const m = entryFor(lensAt(ROOT, '01-bash-access-caret1.txt'), '2.1.330')
    expect(m.degraded).toBe(true)
    expect(m.attention).toBe('registry-version-mismatch')
  })

  test('a four-row list whose last row is not No is refused', () => {
    const raw = readFileSync(join(ROOT, '01-bash-access-caret1.txt'), 'utf8')
    const mutated = raw.replace(/ {3}4\. No/, '   4. Yes')
    const m = entryFor(readLens(mutated), '2.1.321')
    expect(m.degraded).toBe(true)
    expect(m.entry!.options.every((o) => !o.actOn)).toBe(true)
  })
})

describe('cc321 — auto mode disabled keeps the three-row shape', () => {
  for (const v of ['2.1.321', '2.1.325']) {
    const dir = join(CORPORA[v], 'noauto')
    test(`${v}: Bash is three rows, Yes and No act-on`, () => {
      for (const f of capturesIn(dir, /^0\d-bash-/)) {
        expect(lensAt(dir, f).dialog?.options).toHaveLength(3)
        const { m, bits } = mask(dir, f, v)
        expect(m.degraded).toBe(false)
        expect(bits).toBe('101')
      }
    })

    test(`${v}: a Write outside the project still reads as the accept-edits row`, () => {
      const lens = lensAt(dir, '20-write-caret1.txt')
      expect(lens.dialog?.options[1]).toMatch(/; Yes, and always allow access to .* for this session/)
      const { m, bits } = mask(dir, '20-write-caret1.txt', v)
      expect(m.degraded).toBe(false)
      expect(bits).toBe('111')
    })
  }
})

describe('cc321 — Write, Edit and Plan', () => {
  for (const v of VERSIONS) {
    const dir = CORPORA[v]
    test(`${v}: Write and Edit are three rows, all act-on, row 2 the accept-edits switch`, () => {
      for (const f of capturesIn(dir, /^[23]\d-(write|edit)-caret\d\.txt$/)) {
        const lens = appLens(dir, f)
        expect(lens.dialog?.options[1]).toMatch(/^Yes, and switch to accept edits \(auto-approve file edits and common file commands\) for this session/)
        const { m, bits } = mask(dir, f, v)
        expect(m.degraded).toBe(false)
        expect(bits).toBe('111')
      }
    })

    test(`${v}: the plan rows are the 2.1.233 rows`, () => {
      for (const f of capturesIn(dir, /^4\d-plan-caret\d\.txt$/)) {
        const lens = appLens(dir, f)
        expect(lens.dialog?.options.slice(0, 2)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits'])
        const { m, bits } = mask(dir, f, v)
        expect(m.degraded).toBe(false)
        expect(bits).toBe('111')
      }
    })
  }

  test('a Bash call made from PLAN mode draws a different dialog, and chat offers nothing', () => {
    // `80-…`: the session was left in plan mode; the same `touch` came back as a
    // two-row No/Yes gate under "Auto mode can't check actions in this session".
    // The lens does not claim it, so there is no card and no key.
    const lens = lensAt(ROOT, '80-bash-in-plan-mode-autofallback.txt')
    expect(lens.dialog).toBeNull()
    expect(entryFor(lens, '2.1.321').entry).toBeNull()
  })
})

/** One live case: frames in capture order, and the run's own machine log. */
interface LiveLog {
  livePin: string | null
  pinOverridden: boolean
  entryId: RegistryId
  target: number | 'escape'
  cardDegraded: boolean
  outcome: AnswerOutcome
  looks: { tag: string }[]
}

const liveCases = (v: string) => {
  const dir = join(CORPORA[v], 'live')
  if (!existsSync(dir)) return []
  return capturesIn(dir, /-sequence\.json$/).map((f) => ({
    dir,
    name: f.replace(/-sequence\.json$/, ''),
    log: JSON.parse(readFileSync(join(dir, f), 'utf8')) as LiveLog,
  }))
}

async function replay(dir: string, log: LiveLog, pin: string) {
  const sent: KeyName[] = []
  const tags = log.looks.map((l) => l.tag)
  const own = tags.slice(1)
  let i = 0
  const deps: AnswerDeps = {
    refresh: async (continuing) => lensAt(dir, `${own[Math.min(i++, own.length - 1)]}.txt`, continuing),
    sendKey: async (k) => {
      sent.push(k)
    },
    pin,
    wait: async () => {},
  }
  const out = await answerDialog(deps, {
    entryId: log.entryId,
    target: log.target,
    key: sightingKey(lensAt(dir, `${tags[0]}.txt`).dialog!),
  })
  return { out, sent }
}

describe('cc321 — the live runs', () => {
  for (const v of VERSIONS) {
    test(`${v}: eight live cases, every one committed, with no pin substitution`, () => {
      const cases = liveCases(v)
      expect(cases).toHaveLength(8)
      for (const c of cases) {
        expect(c.log.livePin).toBe(v)
        expect(c.log.pinOverridden).toBe(false)
        expect(c.log.cardDegraded).toBe(false)
        expect(c.log.outcome.ok).toBe(true)
        expect(c.log.outcome.committed).toBe(true)
      }
    })

    test(`${v}: replaying the frames through answerDialog sends the same keys`, async () => {
      for (const c of liveCases(v)) {
        const { out, sent } = await replay(c.dir, c.log, v)
        expect(out.ok).toBe(true)
        expect(sent).toEqual(c.log.outcome.sent)
      }
    })

    test(`${v}: No is reached by navigation to row 4 on the four-row card, row 3 on the three-row one`, () => {
      const byName = Object.fromEntries(liveCases(v).map((c) => [c.name, c.log]))
      expect(byName['case1-bash-deny'].outcome.sent).toEqual(['Down', 'Down', 'Down', 'Enter'])
      expect(byName['case6-cmdrule-deny'].outcome.sent).toEqual(['Down', 'Down', 'Down', 'Enter'])
      expect(byName['case7-noauto-bash-deny'].outcome.sent).toEqual(['Down', 'Down', 'Enter'])
    })

    test(`${v}: the effects landed — denials ran nothing, option 2 switched to accept edits, the plan went manual`, () => {
      const after = (name: string) => readFileSync(join(CORPORA[v], 'live', `${name}-99-after.txt`), 'utf8')
      expect(after('case1-bash-deny')).toContain('Interrupted')
      expect(after('case6-cmdrule-deny')).toContain('Interrupted')
      expect(after('case7-noauto-bash-deny')).toContain('Interrupted')
      expect(after('case3-write-option2')).toContain('⏵⏵ accept edits on')
      expect(after('case8-write-outside-option2')).toContain('⏵⏵ accept edits on')
      expect(after('case4-plan-manual')).toContain('⏸ manual mode on')
      expect(after('case4-plan-manual')).toMatch(/(User a|A)pproved Claude.s plan/)
    })
  }
})
