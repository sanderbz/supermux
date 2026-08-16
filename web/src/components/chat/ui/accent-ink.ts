/**
 * A session's pigment, used as TYPE.
 * ─────────────────────────────────────────────────────────────────────────────
 * `accentInk(hue, dark)` is theme-dependent (darkened on light paper, lifted on
 * dark), but a presentational component has no idea which theme it is inside:
 * the app-wide switch is `.dark` on <html> while the design surfaces use a
 * `[data-theme]` SUBTREE, and Tailwind's `dark:` variant only knows about the
 * former (`@custom-variant dark (&:is(.dark *))`).
 *
 * So the component publishes BOTH inks as custom properties and lets CSS pick —
 * the same trick the paper ladder itself uses, one level down. The pick lives in
 * `globals.css` as `.sm-ink-accent`.
 *
 * Why not a single var written by the shell: `--sm-accent` is the FOCUSED
 * session's hue. A provenance chip names a *different* session (`●Patch sent
 * over the failing job`), so it carries its own pigment, not the shell's.
 */
import type { CSSProperties } from 'react'

import { accentInk, characterFromSeed, type MarkPin } from '../../../brand/marks'

/** The class that performs the light/dark pick. Pair with `accentInkVars`. */
export const ACCENT_INK_CLASS = 'sm-ink-accent'

/** Both tiers of a hue, as inline custom properties. */
export function accentInkVars(hue: number): CSSProperties {
  return {
    '--sm-ink-accent-light': accentInk(hue, false),
    '--sm-ink-accent-dark': accentInk(hue, true),
  } as CSSProperties
}

/** The same, addressed by session name — the form components actually use. */
export function accentInkVarsForSeed(seed: string, pin?: MarkPin): CSSProperties {
  return accentInkVars(characterFromSeed(seed, pin).hue)
}
