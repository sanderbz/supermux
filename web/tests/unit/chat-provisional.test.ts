import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { extractProvisionalTail } from '../../src/components/chat/provisional'

/** The live TUI captures the lens is fixtured on — provenance in
 *  `tests/fixtures/tui/README.md`. */
const FIXTURES = join(import.meta.dir, '../fixtures/tui')

describe('extractProvisionalTail', () => {
  test('drops the composer box and status noise, keeps prose', () => {
    const capture = [
      'Some earlier output',
      '',
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
      '✻ Simmering… (esc to interrupt)',
      '╭──────────────────────────────╮',
      '│ ❯                            │',
      '╰──────────────────────────────╯',
      '  ⏵⏵ accept edits on (shift+tab to cycle)',
    ].join('\n')
    const tail = extractProvisionalTail(capture)
    expect(tail).toEqual([
      'Some earlier output',
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
    ])
  })

  test('caps at max lines, keeping the LAST ones', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const tail = extractProvisionalTail(lines.join('\n'), 5)
    expect(tail).toEqual(['line 25', 'line 26', 'line 27', 'line 28', 'line 29'])
  })

  test('ANSI colour is preserved on kept lines, and ANSI-only styling does not defeat the box filter', () => {
    const capture = [
      '[32msome green prose[0m',
      '[38;2;177;185;249m╭───╮[0m',
      '│ ❯ │',
    ].join('\n')
    const tail = extractProvisionalTail(capture)
    expect(tail).toEqual(['[32msome green prose[0m'])
  })

  test('empty capture → empty tail', () => {
    expect(extractProvisionalTail('')).toEqual([])
  })
})

describe('extractProvisionalTail — a freshly started session', () => {
  /** The mobile-proof capture, trimmed: the pty scrollback still holds the
   *  login line and the launch command above Claude's welcome banner, and the
   *  box-top cut alone kept every one of them. */
  /** At the phone's 47 columns the login line WRAPS, so nothing in the window
   *  looks like a whole prompt — the first version of this filter matched none
   *  of the five fragments and the block still drew them (mobile proof,
   *  i01-first-send-light.png). A prompt HEAD is enough: the window is
   *  scrollback, and scrollback holds no in-progress prose. */
  test('a wrapped login line suppresses the block entirely', () => {
    const capture = [
      'supermux@supermux-strato:/tmp',
      '1c3-b2c6-7b2814d510c0/scratch',
      " ~/.bash_profile 2>/dev/null;",
      "/mpx/bin/supermux-edit' VISUA",
      'pad',
      '╭──────────╮',
      '│ ❯        │',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('an email address in prose is not a login line', () => {
    const capture = ['write to a@b.com: it bounced', '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['write to a@b.com: it bounced'])
  })

  test('drops the shell prompt, the launch command and the welcome banner', () => {
    const capture = [
      "supermux@host:/tmp/work$ source ~/.bash_profile 2>/dev/null; claude --name proofpad",
      '╭─── Claude Code v2.1.233 ─────────────╮',
      '│            Welcome back Sander!      │',
      '│      /…/scratchpad/mp-work           │',
      '╰──────────────────────────────────────╯',
      '',
      'Reading the file now,',
      '╭──────────────────────────────╮',
      '│ ❯                            │',
      '╰──────────────────────────────╯',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['Reading the file now,'])
  })

  test('a capture that is ONLY banner + composer has no prose to show', () => {
    const capture = [
      '╭─── Claude Code ───╮',
      '│  Welcome back!    │',
      '╰───────────────────╯',
      '╭───────────────────╮',
      '│ ❯                 │',
      '╰───────────────────╯',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('prose with no box above it is still kept in full', () => {
    const capture = ['first line', 'second line', '╭───╮', '│ ❯ │'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['first line', 'second line'])
  })
})

describe('extractProvisionalTail — the tail is THIS turn', () => {
  /** The pty screen still holds the previous turn while a new one starts, and
   *  the block showed it: a denied Bash call and an old `⎿ Interrupted` under
   *  the caption "Live terminal" (mobile proof, f03-working-light.png). */
  test('everything above the current prompt echo belongs to the confirmed past', () => {
    const capture = [
      '❯ Run the shell command: cowsay-nonexistent --version',
      '● Bash(cowsay-nonexistent --version)',
      '  ⎿  Interrupted · What should Claude do instead?',
      '',
      '❯ Write four short lines about the sea.',
      'The sea keeps time in slow, grey breaths,',
      '╭──────────╮',
      '│ ❯        │',
      '╰──────────╯',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      'The sea keeps time in slow, grey breaths,',
    ])
  })

  test('with no prompt echo in reach the tail is unchanged', () => {
    const capture = ['still writing this', 'and this', '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['still writing this', 'and this'])
  })
})

/**
 * What the block leaked into the owner's very first message (daily-driver QA #8).
 *
 * The rule these three assert is one rule: THE BLOCK IS PROSE OR IT IS NOTHING.
 * A capture that still contains shell, a launch command or a TUI dialog is a
 * capture that never reached the agent's own output, and half of one is not more
 * honest than all of it — the transcript below is complete either way.
 */
describe('extractProvisionalTail — prose, or nothing', () => {
  test('a launch command whose prompt head wrapped off the window is suppressed', () => {
    // Verbatim from the QA capture: the login line is above the 30-line window,
    // so `SHELL_PROMPT_HEAD` matched nothing and the block drew the session's
    // own `claude …` invocation, word-broken, captioned "Live terminal".
    const capture = [
      'ash_profile 2>/dev/null; sour',
      "ermux/.supermux/bin/supermux--edit'; claude --name spike-q",
      'a-daily',
      '╭──────────╮',
      '│ ❯        │',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('an env-assignment wrapper is shell too', () => {
    const capture = ['VISUAL=/home/me/bin/edit claude --name spike', '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('a permission dialog belongs to the CARD, not to the tail', () => {
    // The other half of QA #8: mid-turn the block showed the dialog's own rows,
    // one wrap behind the real screen and mid-word —
    //   `2. Yes, and don't ask agai … 3. No / Esc to cancel · Tab to amend`
    // — beside a choice card drawn from the same capture by a reader that can
    // actually parse it.
    const capture = [
      'Do you want to run this command?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again for: python3 *',
      '   3. No, and tell Claude what to do differently',
      '',
      'Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('a numbered list in PROSE is not a dialog', () => {
    // The rule that keeps the previous one from eating half the turns on this
    // surface: `1.` `2.` `3.` is also how Claude writes a list. Only the
    // dialog's own footer condemns a block.
    const capture = [
      'Three things to do next:',
      '1. Rerun the migration',
      '2. Redeploy the worker',
      '3. Watch the queue',
      '╭──╮',
      '│ ❯│',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      'Three things to do next:',
      '1. Rerun the migration',
      '2. Redeploy the worker',
      '3. Watch the queue',
    ])
  })

  test('a row that FILLS the pane and opens the window takes its continuation with it', () => {
    // A pty hard-wraps at the pane width: a first row that reaches the edge ran
    // off the end of a row above the window, so it starts mid-word — and so does
    // THE ROW UNDER IT, which is the rest of that same wrapped line. Dropping
    // only the first one just moves the fragment down a row; the block resumes
    // at the first row that begins a line, and here there is none.
    const wide = 'x'.repeat(60)
    const capture = [wide, 'a whole line of prose', '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('…and it resumes at the first row that begins a line', () => {
    // The row above `here the turn resumes` stops short of the edge, so it is a
    // line that ENDED — what follows it starts where something started.
    const capture = [
      'x'.repeat(60),
      'the rest of that wrapped line, which stops short',
      'here the turn resumes',
      '╭──╮',
      '│ ❯│',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['here the turn resumes'])
  })

  test('…and a first row that stops short of the edge is kept', () => {
    const capture = ['a whole line of prose', 'x'.repeat(60), '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['a whole line of prose', 'x'.repeat(60)])
  })

  /**
   * The cut the block makes ITSELF (daily-driver QA #8).
   *
   * `slice(-max)` used to pick the twelfth-from-last row with no regard for what
   * it was, so an ordinary streaming paragraph on an 80-column pane opened the
   * "Live terminal · unconfirmed" card mid-word:
   *   `l comma and an American decimal point bo`
   * — the same defect the rule above exists to prevent, one row further down.
   */
  test('the max cut lands on a row that begins a line, never mid-word', () => {
    const W = 80
    const para =
      'Normalising the locale separator before the money column means a European decimal comma and an American decimal point both land on the same integer path, so the rounding step never guesses which convention the export was written under. Adding the Dutch regression case now, then rerunning the whole suite once more to be sure nothing else moved. '.repeat(
        3,
      )
    const rows: string[] = []
    for (let i = 0; i < para.length; i += W) rows.push(para.slice(i, i + W))
    const capture = [...rows, '╭' + '─'.repeat(W - 2) + '╮', '│ ❯' + ' '.repeat(W - 4) + '│'].join('\n')
    const got = extractProvisionalTail(capture)
    // Nothing in this capture ever stops short of the edge until the paragraph
    // itself ends, so there is no honest place to start: the block renders
    // nothing rather than opening on `l comma and an American decimal point bo`.
    expect(got).toEqual([])
  })

  /**
   * The PLAN dialog (daily-driver QA #8, second leak).
   *
   * The footer-token list was written off the PERMISSION dialog, and the plan
   * dialog ends `shift+tab to approve` / `ctrl+g to edit in …` instead — so it
   * walked past, and eight of this repo's own live captures rendered the plan's
   * own option rows as prose under "Live terminal · unconfirmed", beside a
   * choice card drawn from the same bytes. The lens is the reader that can parse
   * these; when it sights a dialog, this block stands down.
   */
  test('a plan-approval screen is the CARD’s, not the tail’s', () => {
    const capture = readFileSync(join(FIXTURES, 'plan-approval.txt'), 'utf8')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('a permission screen is too, whatever its footer says', () => {
    expect(extractProvisionalTail(readFileSync(join(FIXTURES, 'perm-bash.txt'), 'utf8'))).toEqual([])
  })

  /**
   * `source` is a SHELL WORD here, not an English one.
   *
   * `\bsource\s` condemned the whole block on "reading the source files" and
   * "the source of truth" — a coding agent's most ordinary vocabulary — which
   * blanked the tail on prose that was never shell at all. That is the same
   * defect as the leak it was written for, pointed the other way.
   */
  test('prose that says “source” still renders', () => {
    const capture = [
      '╰────────────────────────────────────────────────────────╯',
      'I am reading the source files under server/src to find the parser.',
      'The registry is the source of truth for every fingerprint.',
      '╭──╮',
      '│ ❯│',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      'I am reading the source files under server/src to find the parser.',
      'The registry is the source of truth for every fingerprint.',
    ])
  })

  test('…and a real profile source still condemns the block', () => {
    const capture = ['source /etc/profile.d/tools.sh', 'claude', '╭──╮', '│ ❯│'].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  /** A bare horizontal rule and the status line's model/effort chip are
   *  furniture, not prose — and between them they were the card's ENTIRE
   *  content on nineteen of this repo's live captures. */
  test('a divider rule and the effort chip are not a provisional tail', () => {
    const capture = [
      '╰────────────────────────────────────────────────────────╯',
      '──────────────────────────────────────────────────────────',
      '                                  ● high · /effort',
      '╭──╮',
      '│ ❯│',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([])
  })

  test('…but Claude’s own ● lines are prose and stay', () => {
    const capture = [
      '╰────────────────────────────────────────────────────────╯',
      '● Done. The migration is reverted and the suite is green.',
      '╭──╮',
      '│ ❯│',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      '● Done. The migration is reverted and the suite is green.',
    ])
  })
})

/**
 * THE SHIPPED cc-2.1.233 LAYOUT (verifier `chat-core`, 91-prov-live-7/-10.png).
 *
 * Every rule above was written against the boxed composer — `╭ … │ ❯ │ … ╯`.
 * The layout Claude Code actually ships draws the composer as a BARE `❯ ` row
 * between two full-width rules, with no box below the welcome banner at all, so:
 *
 *   · the box scan found the BANNER's own `╭` (index 0) and cut everything, and
 *   · once the banner had scrolled off, the composer's caret was read as a
 *     prompt echo and moved `start` past every prose row.
 *
 * Either way the "Live terminal · unconfirmed" card rendered ZERO prose lines
 * while the pty demonstrably held the paragraphs at the same instant. These
 * cases pin both layouts, and the last one is the property rather than a
 * transcript: a capture that contains prose never renders nothing.
 */
describe('extractProvisionalTail — the bare-caret composer (cc 2.1.233)', () => {
  const LIVE = readFileSync(join(FIXTURES, 'cc233/60-streaming-prose.txt'), 'utf8')

  test('a bare ❯ is the composer, so the prose above it survives', () => {
    const capture = [
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
      '─'.repeat(60),
      '❯ ',
      '─'.repeat(60),
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      'The agent is writing this paragraph of prose right now,',
      'and a second line of it.',
    ])
  })

  test('a caret with a DRAFT in it is the composer too — the rule above it says so', () => {
    const capture = [
      'still writing this',
      '─'.repeat(60),
      '❯ half a question the user has not sent yet',
      '─'.repeat(60),
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual(['still writing this'])
  })

  test('…and a prompt ECHO still starts the turn, with no rule above it', () => {
    const capture = [
      '❯ Run the shell command: cowsay --version',
      '● Bash(cowsay --version)',
      '',
      '❯ Write four short lines about the sea.',
      'The sea keeps time in slow, grey breaths,',
      '─'.repeat(60),
      '❯ ',
      '─'.repeat(60),
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      'The sea keeps time in slow, grey breaths,',
    ])
  })

  test('the welcome banner’s ╭ is not the composer', () => {
    // The bug's first half: with no box under the banner, the bottom-up box
    // scan cut at index 0 and the block was empty for the WHOLE first session
    // window — banner, prose and all.
    const capture = [
      '╭─── Claude Code v2.1.233 ───╮',
      '│  Welcome back Ada!         │',
      '╰────────────────────────────╯',
      '',
      '❯ Write a short paragraph.',
      '',
      '● Terminal multiplexers matter because a session outlives its window.',
      '─'.repeat(60),
      '❯ ',
      '─'.repeat(60),
    ].join('\n')
    expect(extractProvisionalTail(capture)).toEqual([
      '● Terminal multiplexers matter because a session outlives its window.',
    ])
  })

  test('the live capture renders the prose that is in it, not the status furniture', () => {
    const tail = extractProvisionalTail(LIVE)
    // THE PROPERTY, not a transcript: a capture whose pty rows are prose may
    // never render zero of them. The old rule returned [] on this exact file.
    expect(tail.length).toBeGreaterThan(0)
    const text = tail.join('\n')
    expect(text).toContain('multiplexer')
    // …and none of the furniture that was the card's entire content before.
    expect(text).not.toContain('bypass permissions on')
    expect(text).not.toContain('Transcript saving is off')
    expect(text).not.toContain('Brewed for')
    expect(text).not.toMatch(/^[─╌—]{3,}$/m)
    expect(text).not.toContain('Welcome back')
  })
})
