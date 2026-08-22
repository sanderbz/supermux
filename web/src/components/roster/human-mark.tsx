/**
 * `<HumanMark>` — the human-colleague identity avatar (Companies P3c).
 * ─────────────────────────────────────────────────────────────────────────────
 * The CIRCLE of the three-shape identity convention — company = rounded-square
 * (`<CompanyMark>`) · agent = `<SessionMark>` mascot face · **human colleague =
 * circle** — so which kind of entity you are looking at is legible from
 * silhouette alone (grok-native adaptation of Slack-workspace vs Figma-person).
 * A colleague's message wears this instead of a session's mascot, so human vs
 * agent authorship reads at a glance.
 *
 * THE HUE FIREWALL (non-negotiable, same discipline as `grok-agent-hue.ts` and
 * `<CompanyMark>`). Hue is a pure function of the IMMUTABLE human `id` — a stable
 * `user_id` string, NEVER the mutable `display_name` — via the same
 * `characterFromSeed` hash the session mark and company tile use, so the same
 * person is the same colour everywhere (avatar ring, name chip, message keyline)
 * and a rename never recolours them. Fill = `bodyColor(hue)` at a low wash
 * (theme-independent pigment); the monogram + the ring = `accentInk(hue, dark)`
 * (the text-capable tier), so the initial clears AA *as type* on the wash. This
 * rides ONLY this non-semantic surface; status keeps its own `--sm-tone-*`.
 */
import { characterFromSeed, bodyColor, accentInk } from '@/brand/marks'
import { useTheme } from '@/components/theme-provider'

/** First initial of the display name; falls back to the first code point of the
 *  seed for an empty name. Always ≥1 char, uppercased. */
export function humanMonogram(name: string, seed: string): string {
  const trimmed = name.trim()
  const source = trimmed || seed
  return (Array.from(source)[0] ?? '·').toUpperCase()
}

export interface HumanMarkProps {
  /** The immutable human id (the hue seed — NEVER `display_name`). */
  seed: string
  /** The display name — the monogram source (recolours never). */
  name?: string
  /** Circle diameter in px. Divider 16, gutter 24. */
  size?: number
  className?: string
  /** Force the ink tier's theme (offline bench / a specific-theme preview). */
  dark?: boolean
  style?: React.CSSProperties
}

export function HumanMark({ seed, name = '', size = 24, className, dark, style }: HumanMarkProps) {
  const { resolvedTheme } = useTheme()
  const isDark = dark ?? resolvedTheme === 'dark'
  const hue = characterFromSeed(seed).hue
  const wash = `color-mix(in srgb, ${bodyColor(hue)} 14%, transparent)`
  const ink = accentInk(hue, isDark)
  const mono = humanMonogram(name, seed)
  // Monogram type scale tracks the circle: ~13px @24, ~9px @16.
  const fontSize = Math.round(size * 0.52)
  // The colored ring: 1.5px of `accentInk`, drawn as an inset shadow so the
  // circle stays exactly `size` (no layout growth) at any diameter.
  return (
    <span
      aria-hidden
      className={`gr-hmark${className ? ` ${className}` : ''}`}
      style={{
        display: 'grid',
        placeItems: 'center',
        flex: 'none',
        width: size,
        height: size,
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: '-0.01em',
        userSelect: 'none',
        borderRadius: '9999px',
        background: wash,
        color: ink,
        boxShadow: `inset 0 0 0 1.5px ${ink}`,
        ...style,
      }}
    >
      {mono}
    </span>
  )
}
