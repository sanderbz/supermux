/**
 * T10.5 — the sheet inventory, as a RATCHET.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Five modal systems coexist in this app, and the one that keeps growing is the
 * cheapest to reach for: `import { Drawer } from 'vaul'` and hand-roll an
 * overlay. Every such site re-implements the drag handle, the height, the
 * portal and the scroll lock slightly differently, and none of them get
 * `ResponsiveSheet`'s coarse-pointer fork — so they are bottom sheets on a
 * desktop that wanted a side panel.
 *
 * ── Why a ratchet and not a ban ─────────────────────────────────────────────
 * Eight sites use raw Vaul today. Migrating all of them is a real body of work
 * with a real hazard (quick-peek mounts two `ResponsiveSheet`s OUTSIDE its own
 * `Drawer.Portal`, so a naive migration nests sheets and breaks on touch), and
 * it is deliberately NOT bundled into this test.
 *
 * What this test does is stop the bleeding: the allowlist below is the exact
 * set that exists today, so a NEW raw-Vaul site fails CI immediately, while the
 * existing eight are migrated on their own schedule. The list may only ever
 * SHRINK — removing an entry is the migration; adding one needs a reason good
 * enough to write down here.
 *
 * A test that only banned what is already gone would guard nothing.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../../src', import.meta.url).pathname

/**
 * The ONE sanctioned implementation. Everything else in the allowlist is debt.
 */
const SHEET_PRIMITIVE = 'components/ui/responsive-sheet.tsx'

/**
 * Raw-Vaul sites that exist today. **This list may only shrink.**
 *
 * `pwa/a2hs-sheet.tsx` is the one PERMANENT entry (T10.3): it is
 * `modal={false}` on purpose — the "Add to Home Screen" coaching sheet must not
 * trap focus or block the page, because the thing it is teaching you to do
 * happens in the BROWSER'S OWN chrome, outside the document. Forcing it through
 * `ResponsiveSheet` would make it modal and break the very gesture it exists to
 * demonstrate.
 *
 * The rest are migration targets. Their hazards, so the next reader does not
 * have to rediscover them:
 *
 * * `session-tile/quick-peek-modal.tsx` — mounts `StartTeamSheet` and
 *   `SessionInfoPanel` OUTSIDE its own `Drawer.Portal`, and both are themselves
 *   `ResponsiveSheet`s. A naive migration nests a sheet inside a sheet; the
 *   nesting has to be decided explicitly and verified on a real touch device.
 * * `session-tile/overview-display-menu.tsx` — uses `Drawer.Trigger`, which
 *   `ResponsiveSheet` does not expose.
 * * the other four are straightforward.
 */
const RAW_VAUL_ALLOWLIST = [
  SHEET_PRIMITIVE,
  // permanent — see above
  'components/pwa/a2hs-sheet.tsx',
  // migration targets
  'components/focus-mode/last-send-recall.tsx',
  'components/focus-mode/mobile-action-sheet.tsx',
  'components/focus-mode/session-picker-sheet.tsx',
  'components/session-tile/overview-display-menu.tsx',
  'components/session-tile/quick-peek-modal.tsx',
  'components/session/session-picker.tsx',
  'components/snippets/snippet-editor.tsx',
] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** Every source file that imports Vaul, as a path relative to `src/`. */
function vaulImporters(): string[] {
  return walk(SRC)
    .filter((f) => /from\s+['"]vaul['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => f.slice(SRC.length + 1))
    .sort()
}

describe('raw Vaul is confined to a shrinking allowlist', () => {
  test('no NEW file reaches for Vaul directly', () => {
    const unexpected = vaulImporters().filter(
      (f) => !(RAW_VAUL_ALLOWLIST as readonly string[]).includes(f),
    )
    expect(unexpected).toEqual([])
  })

  test('the allowlist has no dead entries — it must track reality', () => {
    // A stale entry is worse than none: it makes the list look like more debt
    // than exists, and hides the fact that a migration already landed.
    const actual = vaulImporters()
    const dead = (RAW_VAUL_ALLOWLIST as readonly string[]).filter(
      (f) => !actual.includes(f),
    )
    expect(dead).toEqual([])
  })

  test('the sanctioned primitive is one of them, and is not the only one yet', () => {
    const actual = vaulImporters()
    expect(actual).toContain(SHEET_PRIMITIVE)
    // Reads as a progress marker rather than a pass/fail: when this finally
    // equals 2 (the primitive + the permanent a2hs exception), T10's migration
    // is complete and this assertion becomes the strict one.
    expect(actual.length).toBeLessThanOrEqual(RAW_VAUL_ALLOWLIST.length)
  })

  test('the a2hs exception is documented where the exception lives', () => {
    // §15.5's rule applied to code: a deliberate deviation must say why AT the
    // deviation, not only in a test three directories away.
    const src = readFileSync(join(SRC, 'components/pwa/a2hs-sheet.tsx'), 'utf8')
    expect(src).toContain('modal={false}')
    expect(src.toLowerCase()).toContain('responsivesheet')
  })
})
