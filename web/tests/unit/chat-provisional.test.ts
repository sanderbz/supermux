import { describe, expect, test } from 'bun:test'

import { extractProvisionalTail } from '../../src/components/chat/provisional'

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
