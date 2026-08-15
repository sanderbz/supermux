// The peek lens (fase A4 T2) — read against the real captures, never against a
// string typed in this file. Provenance for every fixture (and which two are
// derived rather than captured) is in `tests/fixtures/tui/README.md`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  EMPTY_LENS,
  FAST_PEEK_MS,
  SLOW_PEEK_MS,
  peekCadenceMs,
  readLens,
} from '../../src/components/chat/peek-lens'

const DIR = join(import.meta.dir, '../fixtures/tui')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')

describe('readLens — permission family', () => {
  test('permission/bash: family, variant, options, caret at 0', () => {
    const lens = readLens(read('perm-bash.txt'))
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.dialog?.variant).toBe('bash')
    expect(lens.dialog?.options.length).toBe(3)
    expect(lens.dialog?.options[0]).toBe('Yes')
    expect(lens.dialog?.caretIndex).toBe(0)
    expect(lens.composerDraft).toBeNull()
  })

  test('the caret is read where it actually is, not where it defaults', () => {
    // The shape a0 verified after Down,Down — what T7's caret-verify compares.
    expect(readLens(read('perm-bash-caret2.txt')).dialog?.caretIndex).toBe(2)
  })

  test('permission/edit is not read as bash (no ctrl+e footer, shift+tab in option 2)', () => {
    const lens = readLens(read('perm-edit.txt'))
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.dialog?.variant).toBe('edit')
    expect(lens.dialog?.options[1]).toContain('shift+tab')
  })

  test('permission/write is its own variant', () => {
    expect(readLens(read('perm-write.txt')).dialog?.variant).toBe('write')
  })

  test('options wrapped at 52 cols still match (whitespace-normalised)', () => {
    const lens = readLens(read('perm-bash-52col-derived.txt'))
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.dialog?.variant).toBe('bash') // footer wraps too: "ctrl+e to / explain"
    expect(lens.dialog?.options.length).toBe(3)
    // The continuation line is folded back into its option, not left dangling
    // and not read as a fourth option.
    expect(lens.dialog?.options[1]).toBe(
      'Yes, and always allow access to tmp/ from this project',
    )
  })

  test('the 52-col reading equals the 80-col reading', () => {
    // The wrap must be invisible to every consumer — this is the whole reason
    // fingerprints are token-based (a0 §3 wrap hazard).
    expect(readLens(read('perm-bash-52col-derived.txt')).dialog).toEqual(
      readLens(read('perm-bash.txt')).dialog,
    )
  })
})

describe('readLens — plan family', () => {
  test('plan approval is not read as permission — option-1 text discriminates', () => {
    const lens = readLens(read('plan-approval.txt'))
    expect(lens.dialog?.family).toBe('plan')
    expect(lens.dialog?.options.length).toBe(3)
    expect(lens.dialog?.planPath).toMatch(/^~\/\.claude\/plans\/plan-.*\.md$/)
  })

  test('the question wrapping over two lines still matches', () => {
    // "…ready to execute. Would you like to" / "proceed?" — captured that way.
    expect(read('plan-approval.txt')).toContain('Would you like to\n proceed?')
    expect(readLens(read('plan-approval.txt')).dialog?.family).toBe('plan')
  })

  test('the dynamic editor label is not part of the fingerprint', () => {
    // `ctrl+g to edit in <$VISUAL basename>` — a0 warns it is host-dependent.
    const swapped = read('plan-approval.txt').replace('Supermux-edit', 'nvim')
    expect(readLens(swapped).dialog?.family).toBe('plan')
  })

  test('a permission dialog never reports a plan path', () => {
    expect(readLens(read('perm-bash.txt')).dialog?.planPath).toBeUndefined()
  })
})

describe('readLens — the ❯ collisions', () => {
  test('an echoed ❯ prompt in scrollback is not a dialog', () => {
    expect(readLens(read('composer-idle.txt')).dialog).toBeNull()
  })

  test('a typed TUI draft is seen, an empty composer is not', () => {
    expect(readLens(read('composer-draft.txt')).composerDraft).toBe('half a thought')
    // composer-idle.txt holds an echoed `❯ /clear` ABOVE an empty composer:
    // the echo must not be mistaken for a draft.
    expect(read('composer-idle.txt')).toContain('❯ /clear')
    expect(readLens(read('composer-idle.txt')).composerDraft).toBeNull()
  })

  test('a BOXED composer is still read (the shape A1 fixtured)', () => {
    // Unverified on 2.1.2xx — every live capture has the composer bare — but a
    // missed draft is the one failure that ends in a concatenated send.
    const capture = [
      'some output',
      '╭──────────────────────────────╮',
      '│ ❯ half a thought             │',
      '╰──────────────────────────────╯',
    ].join('\n')
    expect(readLens(capture).composerDraft).toBe('half a thought')
  })

  test('the box outranks an echoed prompt in scrollback', () => {
    // In a boxed-composer TUI every scrollback echo is a bare column-0 `❯`. If
    // the bare fallback outranked the box, an EMPTY box behind an echo would
    // report a phantom draft (T3 would then refuse every send) and a full box
    // would report the echo's words instead of the draft.
    const withEcho = (inside: string) =>
      [
        '❯ fix the bug',
        '  I fixed it.',
        '╭──────────────────────────────╮',
        `│ ❯ ${inside.padEnd(26)}│`,
        '╰──────────────────────────────╯',
      ].join('\n')
    expect(readLens(withEcho('')).composerDraft).toBeNull()
    expect(readLens(withEcho('half a thought')).composerDraft).toBe('half a thought')
  })

  test('a dialog caret is never read as a composer draft', () => {
    expect(readLens(read('perm-bash.txt')).composerDraft).toBeNull()
    expect(readLens(read('plan-approval.txt')).composerDraft).toBeNull()
  })
})

describe('readLens — banner version', () => {
  test('banner version', () => {
    expect(readLens(read('banner.txt')).bannerVersion).toBe('2.1.232')
  })

  test('the compact post-/clear banner reads the same', () => {
    // The other live shape: `▐▛███▜▌   Claude Code v2.1.224`.
    const capture = ' ▐▛███▜▌   Claude Code v2.1.224\n▝▜█████▛▘  Fable 5 · Claude Max\n'
    expect(readLens(capture).bannerVersion).toBe('2.1.224')
  })

  test('null when the banner has scrolled off', () => {
    expect(readLens(read('perm-bash.txt')).bannerVersion).toBeNull()
  })
})

describe('peekCadenceMs', () => {
  test('a live turn polls fast', () => {
    expect(peekCadenceMs({ live: true, dialog: false })).toBe(FAST_PEEK_MS)
  })

  test('a sighted dialog polls fast even when the turn is over', () => {
    // The caret can be moved by another client at any moment (a0 saw it twice),
    // so an idle session with a dialog up is the LEAST safe moment to slow down.
    expect(peekCadenceMs({ live: false, dialog: true })).toBe(FAST_PEEK_MS)
  })

  test('an idle session with a clear screen backs off', () => {
    expect(peekCadenceMs({ live: false, dialog: false })).toBe(SLOW_PEEK_MS)
    expect(SLOW_PEEK_MS).toBeGreaterThan(FAST_PEEK_MS)
  })
})

describe('readLens — totality', () => {
  test('ANSI is stripped before matching', () => {
    const ansi = read('composer-draft-ansi.txt')
    expect(ansi).toContain('\u001b[38;5;244m') // a real SGR run, not a stand-in
    const lens = readLens(ansi)
    expect(lens.composerDraft).toBe('half a thought')
    expect(lens.bannerVersion).toBe('2.1.232')
    expect(lens.dialog).toBeNull()
  })

  test('an empty capture is "nothing on screen", not a throw', () => {
    expect(readLens('')).toEqual(EMPTY_LENS)
  })

  test('prose that merely counts is not a dialog', () => {
    const capture = [
      'Here is what I found:',
      '  1. Yes, the file exists',
      '  2. No, the test is not green',
      '',
      '❯ ',
    ].join('\n')
    expect(readLens(capture).dialog).toBeNull()
  })

  test('a truncated dialog (options only, no question) is SEEN but not act-on-able', () => {
    // It used to degrade to "no sighting", which is the wrong direction: a
    // fingerprint miss must degrade to the Attention card (visible), never to a
    // send (invisible). A caret on a numbered row IS a modal — it will consume
    // the next Enter — so it is reported as `unknown`: unanswerable by the
    // registry, and enough to refuse a send (A4 review).
    const capture = [' ❯ 1. Yes', '   2. Yes, and always allow', '   3. No'].join('\n')
    const dialog = readLens(capture).dialog
    expect(dialog?.family).toBe('unknown')
    expect(dialog?.caretIndex).toBe(0)
  })
})

// ── The three review findings the lens shipped with (A4 review) ─────────────

describe('readLens — the capture is scrollback + screen, not the screen', () => {
  test('a dialog up in the SCROLLBACK is not a dialog on screen', () => {
    // `/peek` returns history followed by the viewport (`native/vt.rs:307`) —
    // which is what makes the deep banner read work. Matched over the whole
    // capture, a permission answered an hour ago read as live forever: every
    // send refused with a false statement about the session, the fast 1s
    // cadence pinned on, and no override anywhere in the UI.
    const capture = `${read('perm-bash.txt')}\n${read('composer-draft.txt')}`
    expect(readLens(capture).dialog).toBeNull()
    // And the live composer below it is seen again, which is the whole point:
    // the draft guard went blind for as long as the false sighting lasted.
    expect(readLens(capture).composerDraft).toBe('half a thought')
  })

  test('prose that quotes a dialog footer does not lock the composer', () => {
    // Assistant prose in this repo quotes TUI footers routinely. Whole-capture
    // matching classified this as a live permission dialog.
    const capture = [
      'Do you want me to run the migration?',
      '  1. Yes',
      '  2. No',
      'The TUI footer reads “Esc to cancel · Tab to amend”, by the way.',
      '',
      'â so I stopped there.',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '❯ ',
    ].join('\n')
    expect(readLens(capture).dialog).toBeNull()
  })

  test('the live dialog is still read when it IS the screen', () => {
    // The guard must not cost the thing it protects: every a0 capture still
    // reads, including with a screenful of scrollback above it.
    const above = Array.from({ length: 40 }, (_, i) => `⏺ some earlier output ${i}`).join('\n')
    const lens = readLens(`${above}\n${read('perm-bash.txt')}`)
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.dialog?.variant).toBe('bash')
  })
})

describe('readLens — the version pin is the BANNER, not any mention of a version', () => {
  test('prose naming a version does not become the pin', () => {
    // The pin is read from a 10 000-line deep capture, and a session that has
    // DISCUSSED a Claude Code version is routine here. Unanchored, the registry
    // certified fingerprints against a number somebody typed — and the honest
    // "could not read the version" branch became unreachable.
    const capture = [
      '⏺ We pinned Claude Code v2.1.227 for the spike.',
      '',
      '❯ ',
    ].join('\n')
    expect(readLens(capture).bannerVersion).toBeNull()
  })

  test('both real banner shapes still read', () => {
    expect(readLens(read('banner.txt')).bannerVersion).toBe('2.1.232')
    expect(readLens('▐▛███▜▌ Claude Code v2.1.231').bannerVersion).toBe('2.1.231')
  })
})
