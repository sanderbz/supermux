/**
 * Daily-driver QA #2 — a receipt has to carry information at PHONE width.
 *
 * Measured on the live instance at 390px: the verb+target cell was 135px holding
 * a 37-character target and the outcome column got ~4 glyphs, so a whole turn of
 * tool calls rendered as `✓ Read /home/s… → 1 …`. Receipts are the majority of a
 * working turn, which made most of the conversation unreadable.
 *
 * The condenser is the data half of the fix (the layout half is
 * `receipt-group.tsx`): the phone shows the BASENAME of a path and the HEAD of a
 * command, and the untouched label stays available for the expanded row.
 */
import { describe, expect, test } from 'bun:test'

import { condenseReceiptLabel, toReceiptRows } from '../../src/components/chat/grouping'

describe('condenseReceiptLabel', () => {
  test('a lone path becomes its basename', () => {
    expect(condenseReceiptLabel('Read /home/supermux/spike-qa/notes.md')).toBe('Read notes.md')
  })

  test('a command keeps its head and shortens the paths inside it', () => {
    expect(condenseReceiptLabel('Bash ls -la /home/supermux/spike-qa')).toBe('Bash ls -la spike-qa')
  })

  test('a label with nothing to shorten is returned unchanged', () => {
    expect(condenseReceiptLabel('Grep parse_locale')).toBe('Grep parse_locale')
    expect(condenseReceiptLabel('cargo test --lib money')).toBe('cargo test --lib money')
  })

  test('a URL keeps its host — a basename would name nothing', () => {
    expect(condenseReceiptLabel('WebFetch https://example.com/blog/post-12.html')).toBe(
      'WebFetch example.com/…',
    )
  })

  test('a trailing slash still names the directory', () => {
    expect(condenseReceiptLabel('Bash ls /home/supermux/spike-qa/')).toBe('Bash ls spike-qa/')
  })

  test('what is still too long is clamped once, at the end', () => {
    const out = condenseReceiptLabel(`Bash ${'a'.repeat(80)}`)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(31)
  })

  test('the verb alone is left alone', () => {
    expect(condenseReceiptLabel('Read')).toBe('Read')
  })
})

describe('toReceiptRows', () => {
  test('carries the condensed label beside the full one', () => {
    const [row] = toReceiptRows([
      { uuid: 'a', label: 'Read /home/supermux/spike-qa/notes.md', result: '1 file · 8 lines' },
    ])
    expect(row.tool).toBe('Read /home/supermux/spike-qa/notes.md')
    expect(row.short).toBe('Read notes.md')
    expect(row.outcome).toBe('1 file · 8 lines')
  })

  test('omits the condensed label when it would say the same thing', () => {
    const [row] = toReceiptRows([{ uuid: 'a', label: 'Grep parse_locale' }])
    expect(row.short).toBeUndefined()
  })

  test('a clamped outcome keeps the full text for the expanded row', () => {
    const long = 'x'.repeat(200)
    const [row] = toReceiptRows([{ uuid: 'a', label: 'Bash echo', result: long }])
    expect(row.outcome?.endsWith('…')).toBe(true)
    expect(row.full).toBe(long)
  })

  test('an unclamped outcome carries no duplicate', () => {
    const [row] = toReceiptRows([{ uuid: 'a', label: 'Bash echo', result: 'done' }])
    expect(row.full).toBeUndefined()
  })

  /**
   * A FAILED call must still read as failed once the row is expanded.
   *
   * `failed · ` is the only thing on a receipt that says a call did not work —
   * the glyph is the same check as a success (`data-state` carries `done` for
   * both). The expanded row swaps `outcome` for `full`, so a `full` without the
   * prefix turns "failed · No such file or directory …" into a line that reads
   * like a result, on the tap a user makes precisely because they could not read
   * the short one.
   */
  test('the expanded read of a failed call still says it failed', () => {
    const long = 'No such file or directory: '.repeat(6)
    const [row] = toReceiptRows([{ uuid: 'a', label: 'Bash cat missing.txt', result: long, ok: false }])
    expect(row.outcome?.startsWith('failed · ')).toBe(true)
    expect(row.full?.startsWith('failed · ')).toBe(true)
    expect(row.full).toContain(long.trim())
  })

  /**
   * A DENIAL IS A DECISION, NOT A DEFECT (round-2 finding 30).
   *
   * The server has always labelled a refused tool_result `denied`
   * (`parser.rs::is_denial`) precisely so this row could say "you declined
   * this" instead of drawing a success tick beside a refusal — and the label was
   * write-only: `grep -rn "'denied'" web/src/components/chat` found one write
   * and no read, while the row printed `failed · The user doesn't want to
   * proceed with this tool use…` for something the user chose on purpose.
   */
  test('a declined call says declined, collapsed and expanded', () => {
    const reason = 'The user doesn’t want to proceed with this tool use. '.repeat(4)
    const [row] = toReceiptRows([
      { uuid: 'a', label: 'Bash rm -rf /tmp/x', result: reason, ok: false, denied: true },
    ])
    expect(row.outcome?.startsWith('declined · ')).toBe(true)
    expect(row.full?.startsWith('declined · ')).toBe(true)
    expect(row.outcome).not.toContain('failed')
    // The clamp still leaves the row exactly as long as a failed one: the verb
    // is two characters longer than "failed" and the room arithmetic follows the
    // verb, so the collapsed row's width does not move.
    const [failed] = toReceiptRows([
      { uuid: 'a', label: 'Bash rm -rf /tmp/x', result: reason, ok: false },
    ])
    expect(row.outcome!.length).toBe(failed.outcome!.length)
  })

  test('…and a call that genuinely failed still says failed', () => {
    const [row] = toReceiptRows([
      { uuid: 'a', label: 'Bash cat missing.txt', result: 'No such file', ok: false },
    ])
    expect(row.outcome).toBe('failed · No such file')
  })
})
