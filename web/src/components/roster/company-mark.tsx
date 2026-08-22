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
 * HQ is NOT a `<CompanyMark>` — it is the brand `.gr-spark` conic tile (the
 * "above all companies" home signal), rendered by the switcher directly.
 */
import { characterFromSeed, bodyColor, accentInk } from '@/brand/marks'
import { useTheme } from '@/components/theme-provider'

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
      className={`gr-cmark${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        fontSize,
        // `--sm-r-md` (10px) rounded-square — the company shape. `grok-identity`
        // is applied by the caller where the hue should SETTLE on a switch.
        background: wash,
        color: ink,
        ...style,
      }}
    >
      {mono}
    </span>
  )
}
