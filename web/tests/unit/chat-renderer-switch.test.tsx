/**
 * The renderer switch — a binary Chat ⇄ Terminal toggle.
 * ─────────────────────────────────────────────────────────────────────────────
 * `auto` was retired: the control shows and drives the ACTIVE renderer. `value`
 * is the mounted surface, a tap pins the other one. The thumb + `aria-selected`
 * sit on the active cell; there is no separate "resolved" marker.
 *
 * Plus the grep-level guard the A1 e2e depends on: the two testids
 * (`renderer-chat`, `renderer-terminal`) must survive a renaming pass.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RendererSwitch } from '../../src/components/chat/renderer-switch'
import type { Renderer } from '../../src/components/chat/renderer-pref'

const html = (
  value: Renderer,
  props: { size?: 'md' | 'sm'; labels?: 'both' | 'selected' } = {},
) =>
  renderToStaticMarkup(
    <RendererSwitch value={value} onChange={() => undefined} {...props} />,
  )

const text = (out: string) =>
  out
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('two cells', () => {
  test('full renders the two WORDS, no Auto', () => {
    const out = html('chat')
    expect(text(out)).toBe('Chat Terminal')
    expect(out).not.toContain('data-testid="renderer-auto"')
    expect(out).toContain('data-testid="renderer-chat"')
    expect(out).toContain('data-testid="renderer-terminal"')
  })

  test('the A1 e2e testids survive (grep-level guard against a rename)', () => {
    // `tests/e2e/smoke/chat-renderer-switch.spec.ts` clicks exactly these.
    for (const v of ['chat', 'terminal'] as const) {
      expect(html(v)).toContain(`data-testid="renderer-${v}"`)
    }
  })

  test('compact (size=sm, labels=selected) keeps two cells, one word + a glyph', () => {
    const out = html('chat', { size: 'sm', labels: 'selected' })
    expect(out).toContain('h-[26px]')
    // The word survives only on the active cell; the other is a glyph.
    expect(text(out)).toBe('Chat')
    expect(out).toContain('data-testid="renderer-terminal"')
    // …and the dropped WORD never drops the NAME.
    expect(out).toContain('aria-label="Terminal"')
  })
})

describe('aria-selected sits on the ACTIVE cell', () => {
  test('chat mounted → chat is selected', () => {
    const out = html('chat')
    expect(out).toMatch(/aria-selected="true" data-testid="renderer-chat"/)
    expect(out).toMatch(/aria-selected="false" data-testid="renderer-terminal"/)
  })

  test('terminal mounted → terminal is selected', () => {
    const out = html('terminal')
    expect(out).toMatch(/aria-selected="true" data-testid="renderer-terminal"/)
    expect(out).toMatch(/aria-selected="false" data-testid="renderer-chat"/)
  })

  test('the moving capsule sits on the selected cell', () => {
    expect(html('chat')).toMatch(/renderer-chat[\s\S]*?bg-fill-soft-2/)
    expect(html('terminal')).toMatch(/renderer-terminal[\s\S]*?bg-fill-soft-2/)
  })
})

describe('no auto machinery survives', () => {
  test('there is no resolved underline and no accent token', () => {
    expect(html('chat')).not.toContain('data-resolved')
    expect(html('chat')).not.toContain('bg-agent')
    expect(html('terminal')).not.toContain('data-resolved')
  })

  test('the aria-label is the plain "Session renderer"', () => {
    expect(html('chat')).toContain('aria-label="Session renderer"')
    expect(html('terminal')).toContain('aria-label="Session renderer"')
    expect(html('chat')).not.toContain('Auto (currently')
  })
})

describe('A3 clothes are unchanged', () => {
  test('the 30px hairline pill and 13.4px labels survive', () => {
    const out = html('chat')
    expect(out).toContain('h-[30px]')
    expect(out).toContain('border-hairline')
    expect(out).toContain('text-[13.4px]')
    expect(out).toContain('role="tablist"')
  })

  test('no colour literals', () => {
    expect(html('chat')).not.toMatch(/#[0-9a-fA-F]{6}/)
  })
})

/**
 * The hit target is not the rail. Measured at 390×844 on the phone header card,
 * the `sm` cells are ~27–31×20 — about a fifth of the 44pt floor by area. The
 * rail's 26px is a VISUAL decision, so the VERTICAL axis is grown with an
 * `::after` expander that changes no layout: 44px tall, centred; on a coarse
 * pointer the PITCH grows (`min-w-11`) and the expander is capped to the cell
 * (`after:w-full`) so neighbours tile instead of overlap.
 */
describe('every cell owns a 44pt hit target', () => {
  for (const size of ['md', 'sm'] as const) {
    test(`size=${size} carries the ::after expander on every cell`, () => {
      const out = html('chat', { size, labels: 'selected' })
      const buttons = out.split('<button').slice(1)
      expect(buttons.length).toBe(2)
      for (const b of buttons) {
        expect(b).toContain('after:h-11') // 44px tall
        expect(b).toContain('[@media(pointer:coarse)]:min-w-11')
        expect(b).toContain('after:w-full')
        expect(b).not.toContain('after:min-w-')
        expect(b).toContain('after:-translate-y-1/2')
        // `renderToStaticMarkup` escapes the quotes inside `content-['']`.
        expect(b).toContain('after:content-[&#x27;&#x27;]')
      }
    })
  }

  test('the visual rail is untouched — 26px compact, 30px full', () => {
    expect(html('chat', { size: 'sm' })).toContain('h-[26px]')
    expect(html('chat', { size: 'md' })).toContain('h-[30px]')
  })
})
