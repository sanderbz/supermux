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
import { entryForSighting } from '../../src/components/chat/registry/claude'

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

/**
 * The FULL-SCREEN PANELS (daily-driver QA #1).
 *
 * `/status` sent from chat opened the CLI's Status panel; chat kept showing an
 * idle dot and an inviting composer, and every later send was refused with "the
 * terminal has an unsent draft `/status`" — quoting the ECHO of the command that
 * opened the panel, 20 rows up in the scrollback. The lens now reports the panel
 * and stops reporting that draft.
 *
 * Fixtures captured live on 2.1.233 in a real pty; provenance in
 * `tests/fixtures/tui/cc233-modal/README.md`.
 */
describe('readLens — a panel is not a draft', () => {
  const modal = (name: string) => readLens(readFileSync(join(DIR, 'cc233-modal', name), 'utf8'))

  test('/status: the panel is sighted, and the scrollback echo is NOT a draft', () => {
    const lens = modal('50-status-modal.txt')
    expect(lens.modal?.hint).toBe('Esc to cancel')
    // The bug, as an assertion: this capture contains `❯ /status` on row 8.
    expect(lens.composerDraft).toBeNull()
    // A panel has nothing to answer, so it is not a dialog either.
    expect(lens.dialog).toBeNull()
  })

  test('/cost: sighted with no ❯ on screen at all', () => {
    expect(modal('51-cost-modal.txt').modal?.hint).toBe('Esc to cancel')
  })

  test('the composer at rest is not a panel', () => {
    const lens = modal('52-idle-composer.txt')
    expect(lens.modal).toBeNull()
    expect(lens.composerDraft).toBeNull()
  })

  test('a RUNNING TURN is not a panel — `esc to interrupt` is lower case, and the prompt is live', () => {
    // The screen a naive "does the tail mention esc?" rule would wreck: it says
    // `esc to interrupt`, and refusing every send during a turn would be an
    // outage wearing a safety argument.
    const lens = modal('53-running-turn.txt')
    expect(lens.modal).toBeNull()
    expect(lens.composerDraft).toBeNull()
  })

  test('a permission dialog stays a DIALOG — one screen, one reading', () => {
    const lens = readLens(read('perm-bash.txt'))
    expect(lens.dialog?.family).toBe('permission')
    expect(lens.modal).toBeNull()
  })

  test('an empty capture is not a panel', () => {
    expect(readLens('').modal).toBeNull()
    expect(readLens('')).toEqual(EMPTY_LENS)
  })
})

/**
 * Daily-driver QA #11 — the card never showed the command being approved.
 *
 * It asked `Run  Download example.com homepage to /tmp pr… ?` — a truncated
 * DESCRIPTION — while `curl -sS https://example.com/ -o /tmp/qa-perm-probe.html
 * && echo done` appeared nowhere in chat (`46-perm-40s.png`,
 * `47-perm-on-reload.png`), only in the terminal (`48-terminal-from-card.png`).
 * The hook's summary is short and secret-conscious by design, so the wire cannot
 * supply the command — but the SCREEN has it, between the variant title and the
 * question, on every capture.
 */
describe('the dialog body, verbatim', () => {
  test('a bash prompt carries its command', () => {
    const body = readLens(read('perm-bash.txt')).dialog!.body
    expect(body).toEqual(['touch /tmp/spike-test-file', 'Create empty file /tmp/spike-test-file'])
  })

  test('the live a4c capture reads the same way, through the scrollback', () => {
    const body = readLens(read('a4c/case1-bash-deny-1-before.txt')).dialog!.body
    expect(body?.[0]).toBe('touch /tmp/spike-a4c-case1.txt')
  })

  test('a write prompt carries the file and its content, without the rules', () => {
    const body = readLens(read('a4c/case3-write-option2-1-before.txt')).dialog!.body
    // The line number is indented one further than the filename on this capture,
    // and it stays that way: the COMMON indent is the terminal's left margin,
    // the relative one is the content's.
    expect(body).toEqual(['case3.txt', ' 1 hello a4c'])
  })

  test('an edit prompt carries its diff, signs intact', () => {
    const body = readLens(read('perm-edit.txt')).dialog!.body
    expect(body).toEqual(['notes.txt', '1  hello', '2 +second'])
  })

  test('the question and the options are not body — they are drawn already', () => {
    const body = readLens(read('perm-bash.txt')).dialog!.body!.join('\n')
    expect(body).not.toContain('Do you want')
    expect(body).not.toContain('1. Yes')
    expect(body).not.toContain('Esc to cancel')
  })

  test('a plan dialog has none: its body is a whole plan, and the card links it', () => {
    const dialog = readLens(read('plan-approval.txt')).dialog!
    expect(dialog.family).toBe('plan')
    expect(dialog.body).toBeUndefined()
    expect(dialog.planPath).toBe('~/.claude/plans/plan-a-tiny-change-purrfect-locket.md')
  })

  test('an unfixtured modal has none — nothing above its rows is known to be its', () => {
    const dialog = readLens(read('a4c/00b-unknown-family-auto-mode-nag.txt')).dialog
    expect(dialog?.family).toBe('unknown')
    expect(dialog?.body).toBeUndefined()
  })
})

/**
 * **`Session paused` — the two consent modals (PTY-07).**
 *
 * The state the catalog calls out twice: needs input, has a consequence
 * (credits, or which model finishes the work), and nothing in the product could
 * see it. The turn does not END, so no `Stop` hook fires and no transcript line
 * is written for the dialog — the pty is the only witness there is.
 */
describe('the paused consent modals', () => {
  const OVERAGE = [
    '────────────────────────────',
    ' Session paused',
    '',
    ' Continue with Fable 5 on usage credits, or switch models.',
    '',
    '   1. Continue on usage credits',
    ' ❯ 2. Switch to the default model',
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n')

  test('the overage modal is read as a paused dialog AND as a notice', () => {
    const lens = readLens(OVERAGE)
    expect(lens.dialog?.family).toBe('paused')
    expect(lens.dialog?.variant).toBe('overage-consent')
    expect(lens.dialog?.question).toBe('Session paused')
    // Both readings, because they answer different questions: the DIALOG is
    // what the card draws, the NOTICE is what stops the roster drawing a green
    // dot over a frozen turn.
    expect(lens.notice?.kind).toBe('session-paused')
    expect(lens.notice?.paused).toBe('overage-consent')
  })

  test('the body — which is where the question actually is — rides verbatim', () => {
    // The title is two words and the rows are two verbs; the body is the only
    // place the user is told what they would be consenting to.
    const lens = readLens(OVERAGE)
    expect(lens.dialog?.body?.join(' ')).toContain('usage credits')
    expect(lens.notice?.detail).toContain('switch models')
    // …and the title is not printed twice.
    expect(lens.dialog?.body?.join(' ')).not.toContain('Session paused')
  })

  test('“safeguards flagged” is what separates the refusal modal from the overage one', () => {
    // Both bodies offer a model switch, so "usage credits" cannot be the
    // discriminator against the refusal — CC's own safeguards sentence is.
    const refusal = readLens(
      [
        '────────────────────────────',
        ' Session paused',
        '',
        " Fable 5's safeguards flagged this message. Switching costs no credits.",
        '',
        ' ❯ 1. Switch to Opus 5',
        '   2. Edit prompt and retry with Fable 5',
        '',
        ' Enter to confirm · Esc to cancel',
      ].join('\n'),
    )
    expect(refusal.dialog?.variant).toBe('refusal-fallback')
    expect(refusal.notice?.paused).toBe('refusal-fallback')
  })

  test('an unrecognised paused body keeps the family and drops the variant', () => {
    // One title, two dialogs today, and a third can ship in any release.
    // "Paused for a reason we do not recognise" is the honest reading; silence
    // is the state this whole family exists to end.
    const lens = readLens(
      [
        '────────────────────────────',
        ' Session paused',
        '',
        ' Something new is being asked here.',
        '',
        ' ❯ 1. Do the thing',
        '   2. Do the other thing',
        '',
        ' Enter to confirm · Esc to cancel',
      ].join('\n'),
    )
    expect(lens.dialog?.family).toBe('paused')
    expect(lens.dialog?.variant).toBeUndefined()
    expect(lens.notice?.kind).toBe('session-paused')
    expect(lens.notice?.paused).toBeUndefined()
    // The registry has no entry for a variant-less paused sighting, so the card
    // is the unmapped one and presses nothing.
    expect(entryForSighting(lens.dialog!)).toBeNull()
  })

  test('the title alone is not a dialog', () => {
    // A capture is scrollback + viewport, and prose about this state is exactly
    // what this repo is full of.
    expect(readLens(' Session paused\n❯\n').dialog).toBeNull()
    expect(readLens('● I will explain what Session paused means.\n❯\n').notice).toBeNull()
  })

  test('a paused modal outranks the limit banner that caused it', () => {
    // The same event seen twice: CC pauses the turn BECAUSE the bucket ran out.
    // Only one of the two readings has a human in it — the block says "come
    // back in five hours", the modal says "answer this and keep going".
    const lens = readLens(
      `  ⎿  You've hit your Fable 5 limit · resets 4am\n${OVERAGE}`,
    )
    expect(lens.notice?.kind).toBe('session-paused')
  })
})

/**
 * **The two live-screen error states (PTY-07).** One is dead and looked
 * transient; the other is alive and looked finished.
 */
describe('the refused turn and the stalled one', () => {
  test('a safeguards refusal is its own notice, with CC’s recovery line', () => {
    const lens = readLens(
      [
        "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Claude Code can't respond to this message with Fable 5.",
        '',
        '  Double press esc to edit your last message, or try a different model with /model.',
        '❯',
      ].join('\n'),
    )
    expect(lens.notice?.kind).toBe('turn-refused')
    // The assistant bullet is CC's gutter, not part of the sentence.
    expect(lens.notice?.text.startsWith('API Error:')).toBe(true)
    expect(lens.notice?.detail).toContain('Double press esc')
  })

  test('an ordinary API error is not a refusal', () => {
    const lens = readLens('● API Error: 529 Overloaded · retrying in 1s\n❯\n')
    expect(lens.notice?.kind).not.toBe('turn-refused')
  })

  test('a stalled stream is reported as live, countdown intact', () => {
    const lens = readLens(
      [
        '✻ Simmering… (esc to interrupt)',
        '  ⎿  Waiting for API response · will retry in 3s · check your network',
      ].join('\n'),
    )
    expect(lens.notice?.kind).toBe('stream-stalled')
    // Verbatim to end of line: the countdown and the remediation are CC's, and
    // no paraphrase of them is more useful than the words it printed.
    expect(lens.notice?.text).toBe(
      'Waiting for API response · will retry in 3s · check your network',
    )
  })

  test('a live compaction is reported as its own transient notice', () => {
    for (const line of [
      'Compacting conversation…',
      'Compacting at auto window (5% left)',
      '✳ compacting history (12.3k tokens)',
    ]) {
      const lens = readLens([`✻ Simmering… (esc to interrupt)`, `  ⎿  ${line}`].join('\n'))
      expect(lens.notice?.kind).toBe('compacting')
    }
  })

  test('the completed compact_boundary prose is NOT a live compaction notice', () => {
    // A finished seam / ordinary sentence must not read as the in-progress hint.
    expect(readLens('● I finished compacting the notes for you.\n❯\n').notice).toBeNull()
    expect(readLens('● Compacting is done; here is the summary.\n❯\n').notice?.kind).not.toBe(
      'compacting',
    )
  })
})

/**
 * **The hard-limit block, tightened (wave 6 #6, #11).** The real captures for
 * the quota wall live in `pty-state-parity` (`limit-weekly`, `limit-session-5h`);
 * these are the NEGATIVE and credit-form edges that no capture covers, typed the
 * same way the ❯-collision and API-error cases above are — the point of each is
 * a string that must NOT read as a block, or a server-enumerated form that must.
 */
describe('readNotice — the quota noun and the gutter anchor', () => {
  test('an ordinary assistant line with no quota noun is NOT a block (#11)', () => {
    // `You've reached your desired deployment state` is prose. Before the `limit`
    // requirement it false-matched, disabled the composer and raised attention.
    expect(readLens('● You’ve reached your desired deployment state.\n❯\n').notice).toBeNull()
  })

  test('the SAME verb with the quota noun, in the banner gutter, IS a block', () => {
    const lens = readLens(
      '  ⎿  You’ve reached your Fable 5 limit. Run /usage-credits to continue.\n❯\n',
    )
    expect(lens.notice?.kind).toBe('limit-blocked')
  })

  test('an assistant QUOTING the banner mid-sentence is not a block (gutter anchor)', () => {
    // The phrase is real, but it is not at the gutter — it is inside a sentence.
    // The old `\b…` match fired on it; the start anchor after `noticeLine` does
    // not.
    expect(
      readLens('● I told them you’ve hit your weekly limit, so we waited.\n❯\n').notice,
    ).toBeNull()
  })

  test('the credit-exhaustion forms the server enumerates block too (#6)', () => {
    // Mirrored from `agent_error.rs::limit_bucket`. None use the "hit/reached
    // your … limit" wording, so the old regex missed every one and left the
    // session composable and Idle in the exact no-transcript case this covers.
    for (const line of [
      'You’re out of usage credits · /upgrade to continue',
      'This action requires usage credits',
      'Your monthly spend limit has been reached',
      'Usage allocation has been disabled for this organization',
    ]) {
      expect(readLens(`  ⎿  ${line}\n❯\n`).notice?.kind).toBe('limit-blocked')
    }
  })
})
