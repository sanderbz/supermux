// The ranker's RELEVANCE FLOOR — the arithmetic that decides whether a row is
// offered at all.
//
// WHY THIS FILE EXISTS. `rankEntities` had no floor: the subsequence branch
// returned at worst 200 for a match whose characters were scattered over an
// entire sentence, and the ⌘K palette ranked commands on `"/cmd <description>"`
// — a full sentence. Almost every query therefore matched something: `dark`
// offered `/supermux-schedule` as its ONLY row, `keyboard` offered
// `/supermux-task`, `files` offered `/supermux-schedule`. Those rows are not
// inert: Enter on one navigates to the freshest session and POSTs the command
// into it, so a mistyped query performed an unintended write into a live agent.
//
// Two rules, asserted here because they are pure arithmetic and because the
// palette's e2e selects rows by TEXT and would stay green while the ranking
// silently regressed (the argument the palette's own header already makes):
//
//   1. A subsequence match must be DENSE.
//   2. A `{ label, extra }` row matches subsequences in the LABEL only; `extra`
//      may match as a substring, and never above a label hit.

import { describe, expect, test } from 'bun:test'

import { fuzzyScore, rankEntities } from '../../src/lib/rank'

// The real corpus, verbatim from the shipped skills (server/src/agents/*.md
// front-matter) — these are the exact strings that produced the live bug.
const SCHEDULE_DESC =
  'Schedule a prompt for YOUR OWN session — a follow-up, a recurring check, a reminder to yourself.'
const TASK_DESC =
  'Report progress on YOUR supermux board issue (comment / done / needs-input / check / link).'
const COMMANDS = [
  { cmd: '/supermux-schedule', desc: SCHEDULE_DESC },
  { cmd: '/supermux-task', desc: TASK_DESC },
]

/** How the palette ranks a command row since the fix: the bare name is the
 *  label, the description is a tiebreaker. */
const asFields = (c: { cmd: string; desc: string }) => ({
  label: c.cmd.replace(/^\//, ''),
  extra: c.desc,
})

describe('the relevance floor', () => {
  test('a scattered subsequence is a MISS, not a 200-point match', () => {
    // `dark` walked 73 characters of the schedule description and won the row.
    expect(fuzzyScore(`/supermux-schedule ${SCHEDULE_DESC}`, 'dark')).toBe(-1)
    expect(fuzzyScore(`/supermux-task ${TASK_DESC}`, 'keyboard')).toBe(-1)
  })

  test('the dense subsequences the ranker exists for still match', () => {
    // The two the file's own documentation promises. Both are real, both are
    // spread out, and a floor tight enough to be elegant would eat them.
    expect(fuzzyScore('server/src/sessions/mod.rs', 'ssmod')).toBeGreaterThan(0)
    expect(fuzzyScore('release-train', 'rt')).toBeGreaterThan(0)
  })

  test('a substring is never touched by the floor, however long the gap', () => {
    // The floor is a SUBSEQUENCE rule. A literal hit at character 80 is still
    // the row the user meant.
    expect(fuzzyScore(`${'x'.repeat(80)}needle`, 'needle')).toBeGreaterThan(0)
  })
})

describe('label vs extra', () => {
  test('the three live queries offer NOTHING rather than a slash command', () => {
    for (const q of ['dark', 'keyboard', 'files']) {
      expect(rankEntities(COMMANDS, q, asFields)).toEqual([])
    }
  })

  test('the command still answers to its own name', () => {
    expect(rankEntities(COMMANDS, 'sched', asFields)[0]?.cmd).toBe('/supermux-schedule')
    expect(rankEntities(COMMANDS, 'task', asFields)[0]?.cmd).toBe('/supermux-task')
  })

  test('a description may still find its row — as a substring', () => {
    // "trash" → "View archived sessions" is the palette's own keyword case, and
    // it has to keep working: the synonyms are what make an action findable.
    const actions = [
      { label: 'View archived sessions', extra: 'archived archive restore trash deleted' },
      { label: 'New group', extra: 'group section divider organize' },
    ]
    expect(rankEntities(actions, 'trash', (a) => a)[0]?.label).toBe(
      'View archived sessions',
    )
  })

  test('a name hit always outranks a description hit', () => {
    // `group` is the NAME of one row and a keyword of the other. The band
    // arithmetic (extra ≤ 120, subsequence label ≥ 200) is what guarantees the
    // order, so assert the order rather than the numbers.
    const rows = [
      { label: 'View archived sessions', extra: 'group archive restore' },
      { label: 'New group', extra: 'section divider' },
    ]
    expect(rankEntities(rows, 'group', (r) => r)[0]?.label).toBe('New group')
  })

  test('an empty query keeps the source order for pair-shaped rows too', () => {
    expect(rankEntities(COMMANDS, '', asFields)).toEqual(COMMANDS)
  })
})
