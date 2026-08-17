/**
 * The chat-surface polish batch (verified finding 24) — the small defects on
 * the primary reading surface that each cost one glance.
 *
 * Grouped in one file because they share nothing but the surface they are on;
 * each `describe` names the sub-finding it pins and why the property (not the
 * markup) is the thing being asserted.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ActivityLine } from '../../src/components/session-tile/activity-status'
import { JumpToBottom } from '../../src/components/chat/conversation'

/**
 * (24.5) THE FOCUS HEADER'S ACTIVITY PILL RENDERED TOFU.
 *
 * `session.activity` is built from hook payloads, and a hook that echoes a
 * Nerd-Font-decorated tool label smuggles a BMP private-use codepoint into a
 * label the header draws in the UI SANS stack — which has no glyph for it, so
 * the pill printed `▯` where the kind prefix should be (chat-core,
 * 23-hdr-zoom.png). The codepoint means nothing outside the font that defined
 * it, so it is stripped rather than chased with a font swap.
 */
describe('the activity line', () => {
  const html = (activity: string) =>
    renderToStaticMarkup(<ActivityLine activity={activity} />)

  test('private-use codepoints never reach the DOM', () => {
    const out = html(' npm test')
    expect(out).not.toMatch(/[-]/)
    expect(out).toContain('npm test')
  })

  test('…including the `title` the tooltip reads', () => {
    // The label rides BOTH the text node and the `title` attribute; stripping
    // one and not the other just moves the tofu into the hover.
    expect(html(' npm test')).not.toMatch(/title="[^"]*[-]/)
  })

  test('ordinary emoji prefixes are untouched — they are the design', () => {
    // `✎`/`⚡` are the kind prefixes the backend has always sent, and they are
    // in the BMP proper, not the PUA.
    expect(html('⚡ npm test')).toContain('⚡ npm test')
  })

  test('a label that was ONLY a private glyph renders nothing at all', () => {
    // Better an absent line than an empty pill: `<ActivityLine>` is mounted
    // unconditionally by both call sites precisely so it can decide this.
    expect(html('')).toBe('')
  })
})

/**
 * (24.1) THE JUMP-TO-BOTTOM PILL COVERED WORDS MID-SENTENCE.
 *
 * A 44px disc centred over the content column lands in the middle of the
 * measure (chat-core, A1-overlap-zoom.png). It belongs on the column's right
 * edge, which is where every board that has this control puts it — so the
 * assertion is on the ALIGNMENT, and on the fact that the pill still shares the
 * track's own column box rather than the whole pane's width.
 */
describe('the jump-to-bottom pill', () => {
  const html = renderToStaticMarkup(
    <JumpToBottom show bottom={96} onClick={() => {}} />,
  )

  /** The WRAPPER's own classes — the button's `justify-center` is its icon
   *  centring itself and says nothing about where the disc sits. */
  const wrapper = /^<div class="([^"]*)"/.exec(html)?.[1] ?? ''

  test('is right-aligned, not centred over the text', () => {
    expect(wrapper).toContain('justify-end')
    expect(wrapper).not.toContain('justify-center')
  })

  test('…inside the same column the transcript is measured in', () => {
    // Aligning to the PANE's right edge instead would strand it in the margin
    // on a wide window.
    expect(wrapper).toContain('max-w-[744px]')
    expect(wrapper).toContain('mx-auto')
  })

  test('and still rides the measured composer height', () => {
    expect(html).toContain('padding-bottom:96px')
  })
})
