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

  test('a truncated dialog (options only, no question) is not act-on-able', () => {
    // Degrading to "no sighting" is correct: T7 refuses to press a key into a
    // dialog it cannot fully see, and the Attention card is what the user gets.
    const capture = [' ❯ 1. Yes', '   2. Yes, and always allow', '   3. No'].join('\n')
    expect(readLens(capture).dialog).toBeNull()
  })
})
