/**
 * The header model chip's words (`src/lib/model-name.ts`). The inputs are the
 * statusline `model` objects Claude Code actually sent, live-captured.
 */
import { describe, expect, test } from 'bun:test'

import { modelFamily, modelFamilyLabel, shortModelName } from '../../src/lib/model-name'

const OPUS_55 = { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } // 2.1.326
const FABLE_52 = { id: 'claude-fable-5-2', display_name: 'Fable 5.2' } // 2.1.326
const OPUS_5_1M = { id: 'claude-opus-5[1m]', display_name: 'Opus 5 (1M context)' } // 2.1.232

describe('shortModelName', () => {
  test("Claude Code's own display name, verbatim when it already fits", () => {
    expect(shortModelName(OPUS_55)).toBe('Opus 5.5')
    expect(shortModelName(FABLE_52)).toBe('Fable 5.2')
  })

  test('drops the parenthetical a header chip has no room for', () => {
    expect(shortModelName(OPUS_5_1M)).toBe('Opus 5')
  })

  test('nothing to say → null, so no chip renders', () => {
    expect(shortModelName(null)).toBeNull()
    expect(shortModelName(undefined)).toBeNull()
    expect(shortModelName({ id: '', display_name: '' })).toBeNull()
  })
})

describe('modelFamily / modelFamilyLabel', () => {
  test('reads the family off the id, [1m] suffix and all', () => {
    expect(modelFamily(OPUS_55)).toBe('opus')
    expect(modelFamily(FABLE_52)).toBe('fable')
    expect(modelFamily(OPUS_5_1M)).toBe('opus')
    expect(modelFamily({ id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' })).toBe('haiku')
  })

  test('a model the picker does not offer has no family, but still a label', () => {
    const other = { id: 'some-provider/model-x', display_name: 'Model X' }
    expect(modelFamily(other)).toBeNull()
    expect(modelFamilyLabel(other)).toBe('Model')
  })

  test('does not match a family inside another word', () => {
    expect(modelFamily({ id: 'magnum-opusculum', display_name: '' })).toBeNull()
  })

  test("the phone chip's one word", () => {
    expect(modelFamilyLabel(FABLE_52)).toBe('Fable')
    expect(modelFamilyLabel(OPUS_5_1M)).toBe('Opus')
    expect(modelFamilyLabel(null)).toBeNull()
  })
})
