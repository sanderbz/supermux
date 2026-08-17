/**
 * Fase A5 T2 — the switch grows a third value.
 * ─────────────────────────────────────────────────────────────────────────────
 * `auto` is not a third renderer; it is a third CHOICE. The control therefore
 * has to say two things at once without becoming two controls:
 *
 *   · what you chose  → the thumb + `aria-selected`, on the PREF cell;
 *   · what you get    → a 1.5px accent underline on the RESOLVED cell, and only
 *                       while the pref is `auto` (with an explicit pin the two
 *                       are the same cell and a second marker would be noise).
 *
 * Plus the grep-level guard the A1 e2e depends on: the two original testids
 * must survive a renaming pass.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RendererSwitch } from '../../src/components/chat/renderer-switch'
import type { Renderer, RendererPref } from '../../src/components/chat/renderer-pref'

const html = (
  value: RendererPref,
  resolved: Renderer = 'chat',
  props: { size?: 'md' | 'sm'; labels?: 'both' | 'selected' } = {},
) =>
  renderToStaticMarkup(
    <RendererSwitch
      value={value}
      resolved={resolved}
      onChange={() => undefined}
      {...props}
    />,
  )

const text = (out: string) =>
  out
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('three cells', () => {
  test('full renders the three WORDS', () => {
    const out = html('auto')
    expect(text(out)).toBe('Auto Chat Terminal')
    expect(out).toContain('data-testid="renderer-auto"')
    expect(out).toContain('data-testid="renderer-chat"')
    expect(out).toContain('data-testid="renderer-terminal"')
  })

  test('the A1 e2e testids survive (grep-level guard against a rename)', () => {
    // `tests/e2e/smoke/chat-renderer-switch.spec.ts` clicks exactly these.
    for (const v of ['auto', 'chat', 'terminal'] as const) {
      expect(html(v)).toContain(`data-testid="renderer-${v}"`)
    }
  })

  test('compact (size=sm, labels=selected) keeps three cells and the A glyph', () => {
    const out = html('chat', 'chat', { size: 'sm', labels: 'selected' })
    expect(out).toContain('h-[26px]')
    // The word survives only on the chosen cell; the other two are glyphs, and
    // the auto glyph is the bare `A`.
    expect(text(out)).toBe('A Chat')
    expect(out).toContain('data-testid="renderer-auto"')
    expect(out).toContain('data-testid="renderer-terminal"')
    // …and the dropped WORDS never drop the NAMES.
    expect(out).toContain('aria-label="Terminal"')
  })
})

describe('the compact rail never spells Auto', () => {
  test('the auto cell is the bare A even when SELECTED', () => {
    // Measured on the 390px phone header card: with the word, "Auto" truncated
    // to "A…" and the session's name lost the difference — the QA #6 rule the
    // third cell would otherwise undo.
    const out = html('auto', 'chat', { size: 'sm', labels: 'selected' })
    expect(text(out)).toBe('A')
    expect(out).not.toContain('>Auto<')
    // …and the thumb still sits on it, so the choice is still legible.
    expect(out).toMatch(/aria-selected="true"[^>]*data-testid="renderer-auto"/)
    expect(out).toMatch(/renderer-auto[\s\S]*?bg-fill-soft-2/)
  })

  test('the FULL rail still spells all three', () => {
    expect(text(html('auto'))).toBe('Auto Chat Terminal')
  })
})

describe('aria-selected is on the PREF cell, never the resolved one', () => {
  test('at auto, `auto` is selected even though chat is mounted', () => {
    const out = html('auto', 'chat')
    // React emits attributes in JSX order, so `aria-selected` leads.
    expect(out).toMatch(/aria-selected="true" data-testid="renderer-auto"/)
    expect(out).toMatch(/aria-selected="false" data-testid="renderer-chat"/)
  })

  test('at an explicit pin, the pin is selected', () => {
    const out = html('terminal', 'terminal')
    expect(out).toMatch(/aria-selected="true" data-testid="renderer-terminal"/)
    expect(out).toMatch(/aria-selected="false" data-testid="renderer-auto"/)
  })

  test('the moving capsule sits on the selected cell', () => {
    expect(html('auto')).toMatch(/renderer-auto[\s\S]*?bg-fill-soft-2/)
    expect(html('terminal', 'terminal')).toMatch(
      /renderer-terminal[\s\S]*?bg-fill-soft-2/,
    )
  })
})

describe('the resolved underline appears ONLY at auto', () => {
  test('auto + resolved chat underlines the chat cell', () => {
    const out = html('auto', 'chat')
    expect(out).toMatch(/data-testid="renderer-chat"[^>]*data-resolved="true"/)
    expect(out).toContain('bg-agent')
    expect(out).not.toMatch(/data-testid="renderer-terminal"[^>]*data-resolved/)
  })

  test('auto + resolved terminal underlines the terminal cell', () => {
    const out = html('auto', 'terminal')
    expect(out).toMatch(/data-testid="renderer-terminal"[^>]*data-resolved="true"/)
    expect(out).not.toMatch(/data-testid="renderer-chat"[^>]*data-resolved/)
  })

  test('an explicit pin shows NO underline (the thumb already says it)', () => {
    expect(html('chat', 'chat')).not.toContain('data-resolved')
    expect(html('terminal', 'terminal')).not.toContain('data-resolved')
    expect(html('chat', 'chat')).not.toContain('bg-agent')
  })

  test('"Auto, currently Chat" is one announcement, not an unexplained mark', () => {
    expect(html('auto', 'chat')).toContain(
      'aria-label="Renderer: Auto (currently Chat)"',
    )
    expect(html('auto', 'terminal')).toContain(
      'aria-label="Renderer: Auto (currently Terminal)"',
    )
    expect(html('chat', 'chat')).toContain('aria-label="Session renderer"')
  })
})

describe('A3 clothes are unchanged', () => {
  test('the 30px hairline pill and 13.4px labels survive the third cell', () => {
    const out = html('auto')
    expect(out).toContain('h-[30px]')
    expect(out).toContain('border-hairline')
    expect(out).toContain('text-[13.4px]')
    expect(out).toContain('role="tablist"')
  })

  test('no colour literals — the underline is a B0 token', () => {
    expect(html('auto')).not.toMatch(/#[0-9a-fA-F]{6}/)
  })
})

/**
 * The hit target is not the rail.
 *
 * Measured at 390×844 on the phone header card, the `sm` cells are 27×20,
 * 31×20 and 31×20 — about a fifth of the 44pt floor by area, on the control the
 * whole Chat⇄Terminal toggle runs through. The rail's 26px is a VISUAL decision
 * (the header card's geometry is built around it), so the target is grown with
 * an `::after` expander instead of by resizing anything: 44px tall, ≥40px wide,
 * centred on the cell, changing no layout.
 *
 * Verified live on `/dev/chat-ui` at 390px: `getComputedStyle(cell, '::after')`
 * reports 44px on every cell at both sizes, and `elementFromPoint` 20px above
 * and 20px below each cell's centre resolves to that same cell — never to its
 * neighbour, so the wider targets cannot become mis-taps.
 */
describe('every cell owns a 44pt hit target', () => {
  for (const size of ['md', 'sm'] as const) {
    test(`size=${size} carries the ::after expander on every cell`, () => {
      const out = html('auto', 'chat', { size, labels: 'selected' })
      const buttons = out.split('<button').slice(1)
      expect(buttons.length).toBe(3)
      for (const b of buttons) {
        expect(b).toContain('after:h-11') // 44px
        expect(b).toContain('after:min-w-[40px]')
        expect(b).toContain('after:-translate-y-1/2')
        // `renderToStaticMarkup` escapes the quotes inside `content-['']`.
        expect(b).toContain('after:content-[&#x27;&#x27;]')
      }
    })
  }

  test('the visual rail is untouched — 26px compact, 30px full', () => {
    expect(html('auto', 'chat', { size: 'sm' })).toContain('h-[26px]')
    expect(html('auto', 'chat', { size: 'md' })).toContain('h-[30px]')
  })
})
