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
