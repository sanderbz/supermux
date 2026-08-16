/**
 * `<ShellOverlay>` — the desktop frame's structural contract (fase B1 T6.6).
 * ─────────────────────────────────────────────────────────────────────────────
 * The component's premise is that desktop and mobile are DIFFERENT structures,
 * not one structure with different padding:
 *
 *   · desktop emits an ABSOLUTE frame inside the shell's content column, so the
 *     nav rail and the route header stay visible beside its scrim. If it ever
 *     regressed to `position: fixed` it would look near-identical in a
 *     screenshot while quietly becoming a full-screen modal — and it would put
 *     a fixed element outside the column it is supposed to be bounded by, which
 *     is the containing-block hazard from the other direction.
 *   · mobile emits `<ResponsiveSheet>` verbatim, because the mobile focus route
 *     strips both navs and lives in its own body-level fixed sheet, which would
 *     simply occlude a shell-absolute overlay.
 *
 * WHY THIS SUITE TESTS `ShellOverlayBody` AND NOT `ShellOverlay`:
 * `react-dom/server` does not execute `createPortal`, and Vaul's
 * `Drawer.Portal` does not render on the server either — so rendering
 * `<ShellOverlay>` yields an empty string from BOTH branches and proves
 * nothing. The portal-free body is exported for exactly this reason, and the
 * device fork itself is proven where it is real: `e2e/smoke/shell-overlay.spec.ts`
 * (desktop overlay + visible nav rail; iPhone → the sheet, and no overlay).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SHELL_OVERLAY_DESKTOP_QUERY,
  ShellOverlayBody,
} from '../../src/components/shell/shell-overlay'
import { FRAME_SIZE_CSS } from '../../src/components/shell/shell-overlay-frame'

function render(variant: 'frame' | 'pane' = 'frame', open = true) {
  return renderToStaticMarkup(
    <ShellOverlayBody
      open={open}
      onOpenChange={() => {}}
      title="Archived sessions"
      description="3 archived sessions"
      variant={variant}
    >
      <p>body</p>
    </ShellOverlayBody>,
  )
}

describe('the desktop frame is absolute, inside the shell', () => {
  test('the overlay root is absolutely positioned and never fixed', () => {
    const html = render()
    expect(html).toContain('data-testid="shell-overlay"')
    expect(html).toContain('class="absolute inset-0"')
    // `fixed` anywhere in the desktop overlay would escape the content column.
    expect(html).not.toMatch(/class="[^"]*\bfixed\b/)
  })

  test('it stacks on the z-ladder token, not a magic number', () => {
    const html = render()
    expect(html).toContain('z-index:var(--sm-z-overlay)')
    expect(html).not.toMatch(/z-index:\s*\d/)
  })

  test('the scrim is the scrim token and is click-to-dismiss', () => {
    const html = render()
    expect(html).toContain('data-testid="shell-overlay-scrim"')
    expect(html).toContain('background:var(--sm-scrim)')
    expect(html).toContain('cursor-default')
  })

  test('the frame is a labelled modal dialog with a close control', () => {
    const html = render()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Archived sessions"')
    expect(html).toContain('aria-label="Close"')
  })

  test('closed renders nothing at all — zero always-on estate', () => {
    expect(render('frame', false)).toBe('')
  })
})

describe('variants change chrome, not structure', () => {
  test('frame: container-query sized against the content column', () => {
    const html = render('frame')
    expect(html).toContain('data-variant="frame"')
    // The exact expression from the pure module — not a re-derived literal.
    expect(html).toContain(`width:${FRAME_SIZE_CSS}`)
  })

  test('pane: pinned to the right edge, and it is a substrate column', () => {
    const html = render('pane')
    expect(html).toContain('data-variant="pane"')
    // `data-shell-pane` is the substrate hook — the pane picks up the 6%
    // accent wash and its own 0.5px hairline from globals.css.
    expect(html).toContain('data-shell-pane')
    expect(html).toContain('inset-y-0 right-0')
    // A pane is edge-pinned, so it must NOT carry the frame's container sizing.
    expect(html).not.toContain(`width:${FRAME_SIZE_CSS}`)
  })

  test('both variants share the same body grid (content never re-typesets)', () => {
    for (const v of ['frame', 'pane'] as const) {
      expect(render(v)).toContain(
        'grid-template-columns:minmax(0, auto) minmax(0, 1fr) minmax(0, auto)',
      )
    }
  })

  test('the header sits on the 44px in-pane chrome floor, not the 56px route one', () => {
    // An overlay is an IN-PANE surface — BRAND.md §6d's per-column decision.
    expect(render()).toContain('safe-header-compact')
    expect(render()).not.toMatch(/class="[^"]*\bsafe-header\b[^-]/)
  })
})

describe('the device fork', () => {
  test('desktop needs BOTH a wide shell and a precise pointer', () => {
    // Width alone would hand a touch tablet a 26px close button; pointer alone
    // would hand a narrow desktop window an overlay with no shell around it.
    expect(SHELL_OVERLAY_DESKTOP_QUERY).toContain('min-width: 768px')
    expect(SHELL_OVERLAY_DESKTOP_QUERY).toContain('pointer: fine')
    expect(SHELL_OVERLAY_DESKTOP_QUERY).toContain(' and ')
  })
})
