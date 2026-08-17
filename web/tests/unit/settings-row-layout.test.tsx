/**
 * A settings row with a WIDE control stacks on a phone (round-2 finding 40).
 * ─────────────────────────────────────────────────────────────────────────────
 * `Row` puts the control trailing on the same line and marks it `shrink-0`, so a
 * wide control takes its width out of the label's column before the label gets a
 * say. Measured at 390x844: "Default view" 192px on one line, "Overview preview"
 * 193px on one line, and "Overview hover preview" 66px over THREE lines beside a
 * 66px nine-line hint — because its control ("Live terminal | Expanded text",
 * ≈262px) plus the gap and the row padding ate 306 of the 390.
 *
 * The fix is opt-in per row, not a blanket restyle: every other row in that
 * section has a short control and reads correctly today, and stacking them all
 * would turn a one-line settings page into a two-line one for no reason.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { Row } from '../../src/components/settings/primitives'

/** The class list of the row's top line (the flex container). */
function topLine(html: string): string {
  const m = /<div class="([^"]*flex[^"]*)"/.exec(html)
  return m?.[1] ?? ''
}

describe('a settings row with a wide control', () => {
  const label = 'Overview hover preview'
  const control = <div>Live terminal | Expanded text</div>

  test('stacks below sm and is unchanged from sm up', () => {
    const cls = topLine(renderToStaticMarkup(<Row label={label} control={control} wideControl />))
    // Phone: one column, so the label owns the full width.
    expect(cls).toContain('flex-col')
    // Desktop: exactly the layout every other row has always had.
    expect(cls).toContain('sm:flex-row')
    expect(cls).toContain('sm:items-center')
  })

  test('an ordinary row is untouched — the control still sits trailing', () => {
    const cls = topLine(renderToStaticMarkup(<Row label="Theme" control={control} />))
    expect(cls).toContain('items-center')
    expect(cls).not.toContain('flex-col')
    expect(renderToStaticMarkup(<Row label="Theme" control={control} />)).toContain('shrink-0')
  })
})
