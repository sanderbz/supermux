/**
 * **The classification parity contract — TypeScript half.**
 *
 * Twin of `server/tests/wrapper_parity.rs`. Both read the SAME corpus file,
 * `server/tests/fixtures/chat/supermux-wrappers.jsonl`, and assert the same
 * `(kind, label, text)` triple for every line.
 *
 * Why a shared file rather than two test suites: there are two independent
 * user-line classifiers in this codebase — `recall.rs::classify_prompt_body`
 * for the recall plane, `wire-entries.ts::classifyPrompt` for the chat
 * WebSocket the shipped renderer rides — and **neither language's switch is
 * exhaustive**. Both have a default arm, by design, so that a brand-new Claude
 * Code wrapper degrades to a system line instead of leaking as a fake prompt.
 * The cost of that design is that a wrapper taught to one plane and forgotten
 * on the other compiles clean in Rust *and* in TypeScript. That is exactly what
 * happened to the fabric spine: `<supermux-delegation>` was classified
 * server-side, fell to `default:` here, became `kind:'system'`, and was then
 * dropped by the survives-filter — so every delegated prompt and every
 * scheduled fire was invisible in the renderer that ships.
 *
 * These tests are the only thing that can catch that class of drift. If you add
 * an arm to either classifier, add a corpus line in the same commit.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { classifyPrompt, SURVIVING_KINDS } from '../../src/components/chat/wire-entries'

interface CorpusRow {
  name: string
  input: string
  kind: string
  label?: string
  text: string
  survives: boolean
}

const CORPUS: CorpusRow[] = readFileSync(
  new URL('../../../server/tests/fixtures/chat/supermux-wrappers.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as CorpusRow & { _?: string })
  // The first object is the file's own documentation, not a case.
  .filter((r) => r._ === undefined)

describe('the shared wrapper corpus', () => {
  test('is present and has not shrunk below the nine shapes the fase enumerated', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(9)
  })

  test('still covers both wrappers, a nested closer, a pasted wrapper and an unknown tag', () => {
    // A corpus can rot by losing its adversarial lines while still passing.
    const kinds = CORPUS.map((r) => r.kind)
    expect(kinds).toContain('delegation')
    expect(kinds).toContain('schedule')
    expect(
      CORPUS.some((r) => r.input.split('</supermux-delegation>').length > 2),
    ).toBe(true)
    expect(CORPUS.some((r) => r.input.includes('from="ceo"'))).toBe(true)
    expect(CORPUS.some((r) => r.input.startsWith('<some-future-wrapper'))).toBe(true)
  })
})

describe('classifyPrompt agrees with recall.rs on every corpus line', () => {
  for (const row of CORPUS) {
    test(row.name, () => {
      const got = classifyPrompt(row.input)
      expect(got.kind).toBe(row.kind as never)
      expect(got.text).toBe(row.text)
      expect(got.label).toBe(row.label as never)
    })
  }
})

describe("the renderer's calm-view filter agrees with is_user_initiated", () => {
  for (const row of CORPUS) {
    test(row.name, () => {
      expect(SURVIVING_KINDS.has(classifyPrompt(row.input).kind)).toBe(row.survives)
    })
  }
})

describe('the parity fix itself', () => {
  test('a delegated prompt survives the filter — the bug this fase exists to close', () => {
    const c = classifyPrompt(
      '<supermux-delegation from="deploy-fix">rebase please</supermux-delegation>',
    )
    expect(c.kind).toBe('delegation')
    expect(SURVIVING_KINDS.has(c.kind)).toBe(true)
  })

  test('a scheduled fire survives the filter', () => {
    const c = classifyPrompt(
      '<supermux-schedule id="S-1" title="Nightly">check it</supermux-schedule>',
    )
    expect(c.kind).toBe('schedule')
    expect(SURVIVING_KINDS.has(c.kind)).toBe(true)
  })

  test('an unknown future wrapper still degrades to system and is still dropped', () => {
    // The `default:` arm is the protection against a new Claude Code wrapper
    // leaking as a fake prompt. Widening the filter must not have widened that.
    const c = classifyPrompt('<brand-new-wrapper>surprise</brand-new-wrapper>')
    expect(c.kind).toBe('system')
    expect(SURVIVING_KINDS.has(c.kind)).toBe(false)
  })
})
