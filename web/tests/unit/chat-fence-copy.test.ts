import { describe, expect, test } from 'bun:test'
import { fenceCopyText, shouldTapCopy } from '../../src/components/chat/markdown/fence-copy'

describe('fenceCopyText', () => {
  test('plain fence: verbatim, one trailing newline trimmed', () => {
    expect(fenceCopyText('npm i\nnpm test\n')).toBe('npm i\nnpm test')
  })
  test('JSON keeps its exact whitespace', () => {
    const json = '{\n  "mcpServers": {\n    "x": { "command": "npx" }\n  }\n}\n'
    expect(fenceCopyText(json)).toBe(json.slice(0, -1))
  })
  test('diff: post-change version, markers stripped, removals dropped', () => {
    expect(fenceCopyText(' a\n-b\n+c\n d\n')).toBe('a\nc\nd')
  })
  test('a single leading minus is not a diff', () => {
    expect(fenceCopyText('-x\n')).toBe('-x')
  })
  test('empty fence copies empty string', () => {
    expect(fenceCopyText('')).toBe('')
  })
})

describe('shouldTapCopy', () => {
  test('tap copies only on coarse pointer with no selection inside', () => {
    expect(shouldTapCopy(true, false)).toBe(true)
    expect(shouldTapCopy(false, false)).toBe(false)
    expect(shouldTapCopy(true, true)).toBe(false)
  })
})
