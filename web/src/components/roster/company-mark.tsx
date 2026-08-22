/**
 * `<CompanyMark>` — the shared company identity tile (Companies, Bot Mode).
 * ─────────────────────────────────────────────────────────────────────────────
 * The company avatar reused in every companies surface: the switcher trigger,
 * the popover rows, and the create-sheet live preview. It is the ROUNDED-SQUARE
 * of the three-shape identity convention (company = rounded-square · agent =
 * `<SessionMark>` mascot face · person = circle later), so which kind of entity
 * you are looking at is legible from silhouette alone (grok-native adaptation of
 * the Slack-workspace vs Figma-person separation).
 *
 * THE HUE FIREWALL (non-negotiable, same discipline as `grok-agent-hue.ts`).
 * Hue is a pure function of the IMMUTABLE `slug` — `characterFromSeed(slug).hue`
 * — never the mutable `display_name`, so a rename cannot recolour a company. The
 * fill is `bodyColor(hue)` at a low wash (theme-independent pigment); the
 * monogram is `accentInk(hue, dark)` — the text-capable tier, darkened on light
 * paper / lifted on dark — so the letters clear AA *as type* on the wash. This
 * rides ONLY this non-semantic surface; status keeps its own `--sm-tone-*`
 * family elsewhere.
 *
 * HQ is NOT a `<CompanyMark>` — it has no slug/hue. It is `<HqMark>` (below):
 * the real supermux brand `<Logo>` (the blue angular "S") centred on a neutral
 * rounded-square tile. It keeps the rounded-square silhouette (so HQ still reads
 * as "a space") but shows the actual brand mark, not the invented rainbow spark
 * it used to. `<HqMark>` is the HQ analogue of `<CompanyMark>`.
 */
import { characterFromSeed, bodyColor, accentInk } from '@/brand/marks'
import { useTheme } from '@/components/theme-provider'
import { Logo } from '@/components/logo'

/** 1–2 letters from the display name: initials of the first two words, or the
 *  first 1–2 characters of a single word. Uppercased; always ≥1 char for any
 *  non-empty name (falls back to the first code point). */
export function companyMonogram(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '·'
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase()
  }
  return (words[0][0] + words[1][0]).toUpperCase()
}

export interface CompanyMarkProps {
  /** The immutable company slug — the hue seed (NEVER `display_name`). */
  slug: string
  /** The human name — the monogram source (recolours never, letters follow it). */
  name: string
  /** Tile edge in px. Dense rows 20, standard rows/trigger 24. */
  size?: number
  className?: string
  /** Force the ink tier's theme (offline bench / a specific-theme preview). When
   *  omitted the live resolved theme drives it. */
  dark?: boolean
  style?: React.CSSProperties
}

/**
 * `identityTileStyle(size)` — the shared rounded-square GEOMETRY of the identity
 * system's tiles (company monogram + HQ brand mark), returned as an inline
 * `CSSProperties` so it renders IDENTICALLY regardless of ancestor. Both marks
 * render inside `<ResponsiveSheet>` bodies that portal to `document.body` OUTSIDE
 * the `[data-grok]` shell, so a `[data-grok]`-scoped class (the old `.gr-cmark`)
 * silently dropped every geometry prop in the mobile switcher rows + the
 * create-preview — a bare unstyled square. Inlining with token fallbacks
 * (`--sm-r-md` → 10px, `--sm-border` → a `currentColor` keyline) is the fix, and
 * factoring it here means the company shape has EXACTLY ONE definition that
 * cannot drift back into a scoped class. Consumed by both `CompanyMark` and
 * `HqMark` below.
 */
export function identityTileStyle(size: number): React.CSSProperties {
  return {
    boxSizing: 'border-box',
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
    width: size,
    height: size,
    // `--sm-r-md` (10px) rounded-square — the company shape. Fallbacks so it
    // survives outside the `[data-grok]` subtree (portaled sheets/menus).
    borderRadius: 'var(--sm-r-md, 10px)',
    boxShadow:
      'inset 0 0 0 0.5px var(--sm-border, color-mix(in srgb, currentColor 12%, transparent))',
  }
}

export function CompanyMark({
  slug,
  name,
  size = 24,
  className,
  dark,
  style,
}: CompanyMarkProps) {
  const { resolvedTheme } = useTheme()
  const isDark = dark ?? resolvedTheme === 'dark'
  const hue = characterFromSeed(slug).hue
  const wash = `color-mix(in srgb, ${bodyColor(hue)} 14%, transparent)`
  const ink = accentInk(hue, isDark)
  const mono = companyMonogram(name)
  // Monogram type scale tracks the tile: ~13px @24, ~11px @20, ~18px @34.
  const fontSize = Math.round(size * 0.52)
  return (
    <span
      aria-hidden
      className={className}
      // SELF-CONTAINED (like `<HqMark>`): all geometry is inline via the shared
      // `identityTileStyle` so the tile is byte-identical in the header trigger,
      // the desktop menu rows, the portaled mobile sheet rows, AND the
      // create-preview — no `[data-grok]` ancestor dependency. `grok-identity`
      // (the 0.6s hue settle) is still applied by the caller via `className`.
      style={{
        ...identityTileStyle(size),
        fontSize,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        lineHeight: 1,
        userSelect: 'none',
        background: wash,
        color: ink,
        ...style,
      }}
    >
      {mono}
    </span>
  )
}

export interface HqMarkProps {
  /** Tile edge in px. Matches the CompanyMark scale: trigger 22, rows 24/28. */
  size?: number
  className?: string
  style?: React.CSSProperties
}

/**
 * `<HqMark>` — the HQ identity mark: the real supermux brand `<Logo>` centred on
 * a neutral rounded-square tile. HQ has no slug/hue (it is not a company), so it
 * gets no monogram wash; it keeps the rounded-square silhouette of the identity
 * system (company = rounded square) so it still reads as "a space", but shows the
 * actual blue-S brand mark instead of the invented conic rainbow spark it used to.
 * Used by the CompanySwitcher trigger (HQ scope) and its HQ option row.
 *
 * Styled inline (not via a `[data-grok]`-scoped class) so it renders identically
 * in the header trigger, the desktop anchored menu, AND the mobile bottom sheet —
 * the sheet is portaled to `document.body`, outside the `[data-grok]` subtree, so
 * grok-only tokens/classes would not reach it. `currentColor`-mix tints keep the
 * tile theme-aware anywhere; `--sm-r-md` falls back to 10px off grok. The `<Logo>`
 * SVG's default `preserveAspectRatio` keeps the S un-stretched inside the square.
 */
export function HqMark({ size = 24, className, style }: HqMarkProps) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        ...identityTileStyle(size),
        padding: Math.round(size * 0.15),
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
        ...style,
      }}
    >
      <Logo title="HQ" className="block h-full w-full" />
    </span>
  )
}
