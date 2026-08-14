/**
 * The `/dev/chat-ui` fixture — a coverage contract, not a fixture dump.
 *
 * The bench exists so that the primitives can be reviewed against the approved
 * render and regressed by every later phase. That claim only holds if the page
 * really does show every primitive and really does exercise the states that are
 * easy to break: the selected row, the attention dot, a crew row, a coalescing
 * receipt run, a live line. So that is asserted here rather than eyeballed.
 *
 * It also pins the parity claim: the board's cast is the marks bench's approved
 * cast, so `/dev/marks` and `/dev/chat-ui` cannot disagree about what Patch
 * looks like.
 */
import { describe, expect, test } from 'bun:test'

import * as ui from '../../src/components/chat/ui'
import { coalesceReceipts } from '../../src/components/chat/ui/receipt-group'
import { REFERENCE_STRIP } from '../../src/routes/dev-marks.cast'
import {
  BENCH_THEMES,
  BOARD_CHOICE,
  BOARD_RECEIPTS,
  BOARD_ROSTER,
  CAST,
  FOCUS,
  pinFor,
  PLAN_CHOICE,
  PRIMITIVES,
  VOLUME_RECEIPTS,
  PHONE_CLOSE,
  PHONE_RECEIPTS,
  PHONE_TAIL,
  PHONE_THREAD,
} from '../../src/routes/dev-chat-ui.fixture'

describe('the bench shows every primitive', () => {
  test('each of the ten is exported by the barrel it claims to bench', () => {
    for (const name of PRIMITIVES) {
      expect(ui, name).toHaveProperty(name)
    }
  })

  test('both themes are benched', () => {
    expect([...BENCH_THEMES]).toEqual(['light', 'dark'])
  })
})

describe('the board is the approved board', () => {
  test('its cast is the marks bench cast — one design system, one set of faces', () => {
    for (const member of REFERENCE_STRIP) {
      expect(CAST.get(member.name)).toEqual(member.pin)
    }
    expect(CAST.size).toBe(REFERENCE_STRIP.length)
  })

  test('the focused session is on the roster, and has a face', () => {
    expect(BOARD_ROSTER.some((r) => r.name === FOCUS)).toBe(true)
    expect(pinFor(FOCUS)).toBeDefined()
  })

  test('every non-crew row resolves to a pinned character', () => {
    for (const row of BOARD_ROSTER) {
      if (row.crew) continue
      expect(pinFor(row.name), row.name).toBeDefined()
    }
  })

  test('every crew member resolves too — a team row is three real colleagues', () => {
    const crewRows = BOARD_ROSTER.filter((r) => r.crew)
    expect(crewRows.length).toBeGreaterThan(0)
    for (const row of crewRows) {
      expect(row.crew!.length).toBe(3)
      for (const member of row.crew!) expect(pinFor(member), member).toBeDefined()
    }
  })
})

describe('the roster exercises the row states that break', () => {
  test('an attention row, a crew row, a presence row and a stopped-ish row', () => {
    expect(BOARD_ROSTER.some((r) => r.attention)).toBe(true)
    expect(BOARD_ROSTER.some((r) => r.crew)).toBe(true)
    expect(BOARD_ROSTER.some((r) => r.preview === 'Typing…')).toBe(true)
    expect(BOARD_ROSTER.some((r) => r.state === 'done')).toBe(true)
  })

  test('every row carries a preview — the preview IS the status line', () => {
    for (const row of BOARD_ROSTER) {
      expect(row.preview.length, row.name).toBeGreaterThan(0)
      expect(row.timestamp.length, row.name).toBeGreaterThan(0)
    }
  })

  test('the focused row and the roster tail differ in state, so the faces differ', () => {
    const states = new Set(BOARD_ROSTER.map((r) => r.state))
    expect(states.size).toBeGreaterThanOrEqual(4)
  })
})

describe('the receipt fixtures', () => {
  test('the board group is the calm three-line turn, verbatim', () => {
    expect(BOARD_RECEIPTS.map((r) => r.tool)).toEqual(['cargo check', 'tests', 'release'])
    expect(coalesceReceipts(BOARD_RECEIPTS)).toHaveLength(3)
  })

  test('the volume group actually coalesces, and ends on a live line', () => {
    const lines = coalesceReceipts(VOLUME_RECEIPTS)
    expect(lines.length).toBeLessThan(VOLUME_RECEIPTS.length)
    expect(lines.some((l) => l.count === 12)).toBe(true)
    // A repeat whose outcome really was identical keeps it; the 12-file run
    // does not — that is the honesty rule, on the page.
    expect(lines.some((l) => l.count === 2 && l.outcome === 'no matches')).toBe(true)
    expect(lines.at(-1)?.state).toBe('running')
  })
})

describe('the choice card fixture', () => {
  test('is a real permission ask: a command, a consequence, three options', () => {
    expect(BOARD_CHOICE.command).toContain('cargo publish')
    expect(BOARD_CHOICE.why).toContain('·')
    expect(BOARD_CHOICE.options).toHaveLength(3)
  })

  test('exactly one option is the emphasised default', () => {
    expect(BOARD_CHOICE.options.filter((o) => 'primary' in o && o.primary)).toHaveLength(1)
  })

  test('the board card carries NO digit hints — the render has none', () => {
    // The board half of the bench is the parity anchor for board-*.png. The
    // digits are P5's, and they are shown on the plan card instead.
    for (const option of BOARD_CHOICE.options) expect(option).not.toHaveProperty('kbd')
  })

  test('the plan card is the registry mapping: real labels, digits 1..N in order', () => {
    expect(PLAN_CHOICE.options.map((o) => o.label)).toEqual([
      'Yes, and use auto mode',
      'Yes, manually approve edits',
      'Tell Claude what to change',
    ])
    expect(PLAN_CHOICE.options.map((o) => o.kbd)).toEqual(['1', '2', '3'])
  })
})

describe('the phone board is the approved phone board', () => {
  test('it is a real thread, not a stub — and it is the SAME session, later', () => {
    // mobile-*.png is the desktop board's session after the crates.io ask was
    // allowed, which is why it closes on "done. it's live." and carries no
    // choice card. A phone bench that ends on the ask is benching the wrong
    // moment.
    const all = [...PHONE_THREAD, ...PHONE_TAIL, ...PHONE_CLOSE]
    expect(all.length).toBeGreaterThan(10)
    expect(all.at(-1)!.text).toBe("done. it's live.")
    expect(all.at(-1)!.state).toBe('done')
  })

  test('both sides speak — the phone shows the user bubble ceiling too', () => {
    const all = [...PHONE_THREAD, ...PHONE_TAIL, ...PHONE_CLOSE]
    expect(all.some((t) => t.from === 'me')).toBe(true)
    expect(all.some((t) => t.from === 'agent')).toBe(true)
  })

  test('the phone receipt group is the shorter two-line one', () => {
    expect(PHONE_RECEIPTS.map((r) => r.tool)).toEqual(['tests', 'release'])
  })
})

describe('the phone has its own ceilings', () => {
  test('both are narrower than desktop, and the user side stays the narrower one', () => {
    expect(ui.BUBBLE_MAX.phoneAssistant).toBeLessThan(ui.BUBBLE_MAX.assistant)
    expect(ui.BUBBLE_MAX.phoneUser).toBeLessThan(ui.BUBBLE_MAX.user)
    expect(ui.BUBBLE_MAX.phoneUser).toBeLessThan(ui.BUBBLE_MAX.phoneAssistant)
  })

  test('the artboard is 390x844 — mobile-light.png, to the pixel', () => {
    expect(ui.PHONE.width).toBe(390)
    expect(ui.PHONE.height).toBe(844)
    // The header FLOATS: it is inset from both edges and seated below the
    // status bar, which is the phone's one structural departure from the board.
    expect(ui.PHONE.head.top).toBe(ui.PHONE.topbar)
    expect(ui.PHONE.head.inset).toBeGreaterThan(0)
  })
})
