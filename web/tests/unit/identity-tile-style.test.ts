/**
 * `identityTileStyle(size)` — the shared rounded-square GEOMETRY of the identity
 * tiles (`<CompanyMark>` monogram + `<HqMark>` brand mark). It exists because
 * both marks render inside `<ResponsiveSheet>` bodies that portal to
 * `document.body` OUTSIDE the `[data-grok]` shell, so the old
 * `[data-grok] .gr-cmark` rule silently dropped every geometry prop there (a bare
 * unstyled square). These vectors pin the SELF-CONTAINED contract: the returned
 * inline style carries the full geometry with token FALLBACKS so it renders
 * identically with no `[data-grok]` ancestor, and the company shape has exactly
 * one definition (both marks consume this).
 */
import { describe, expect, test } from 'bun:test'

import { identityTileStyle } from '@/components/roster/company-mark'

describe('identityTileStyle — self-contained tile geometry', () => {
  test('centres its content as a fixed-size, non-shrinking grid', () => {
    const s = identityTileStyle(28)
    expect(s.display).toBe('grid')
    expect(s.placeItems).toBe('center')
    expect(s.flex).toBe('none')
    expect(s.boxSizing).toBe('border-box')
    expect(s.width).toBe(28)
    expect(s.height).toBe(28)
  })

  test('rounds via --sm-r-md WITH a 10px fallback (survives outside [data-grok])', () => {
    const s = identityTileStyle(24)
    expect(String(s.borderRadius)).toBe('var(--sm-r-md, 10px)')
  })

  test('draws the 0.5px keyline via --sm-border WITH a currentColor fallback', () => {
    const s = identityTileStyle(24)
    // A bare `var(--sm-border)` with no fallback would resolve to nothing in a
    // portaled sheet — the exact bug. The fallback keeps the hairline everywhere.
    expect(String(s.boxShadow)).toContain('inset 0 0 0 0.5px')
    expect(String(s.boxShadow)).toContain('var(--sm-border,')
    expect(String(s.boxShadow)).toContain('currentColor')
  })

  test('size threads straight through (each caller size is honoured)', () => {
    for (const size of [22, 24, 28, 44]) {
      const s = identityTileStyle(size)
      expect(s.width).toBe(size)
      expect(s.height).toBe(size)
    }
  })
})
