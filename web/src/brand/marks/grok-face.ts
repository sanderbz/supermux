/**
 * Grok-skin character tuning — the eye + pigment upgrade, grok-only.
 * ─────────────────────────────────────────────────────────────────────────────
 * The base character (`characterFromSeed`) is shipped and FROZEN: its draw order
 * is a contract and the base app must stay byte-identical, so nothing here
 * touches it. Instead `grokTune` takes a finished `Character` and returns a
 * grok-flavoured copy that `session-mark.tsx` uses ONLY when the skin is on.
 *
 * It fixes the two remaining "2/10" complaints the smooth blob doesn't:
 *
 *   EYES read confident and intentional, not derpy. Under the skin the eyes are
 *   negative-space cut-outs, so a face that looks slightly cross-eyed or
 *   head-turned reads as a mistake, not a personality. So we:
 *     · seat both eyes on ONE consistent circular face solid (a centred sphere)
 *       regardless of silhouette — the base app wraps eyes onto per-shape solids
 *       (and shifts the authored ones DOWN by `faceDY`), which on a blob put the
 *       eyes low and off. A single face means every blob's eyes sit dead-centre.
 *     · pull the head pose almost forward (×0.3) so the pair faces you.
 *     · centre the resting gaze (×0.3) so idle isn't a permanent side-eye.
 *     · calm the idle tilt (×0.5) toward Grok's near-vertical capsules.
 *     · halve the per-eye asymmetry so the two eyes look like a matched pair with
 *       a little life, not two unrelated dots.
 *   None of this flattens the STATE vocabulary: `eyesFor` still applies the full
 *   working/waiting/done/failed/… deltas on top of the calmer resting geometry.
 *
 *   PIGMENT pops like Grok's clean, saturated-but-calm hues instead of reading
 *   muddy. The base `HUE_TRIM` is tuned for white eyes on warm paper; the grok
 *   ramp lifts lightness and chroma (especially the low-chroma greens/teals) so
 *   the body sings behind a cut-out eye in both themes. Per-slug determinism is
 *   untouched — the hue channel still comes from the immutable slug.
 *
 * PURE + DOM-free. Deterministic. Reached only from the grok render branch.
 */
import { type Character, oklchHex } from './character'

/**
 * The Grok pigment ramp — brighter, cleaner OKLCh `[L, C]` per hue angle than the
 * base `HUE_TRIM`. Same seven hue slots (identity preserved); the muddy mid
 * greens/teals (158 · 190) get the biggest chroma lift so the roster reads as a
 * clean teal/green/blue/indigo/violet/amber/coral rainbow, like Grok's frames.
 */
const GROK_TRIM: Readonly<Record<number, readonly [number, number]>> = {
  28: [0.7, 0.178], // coral / warm red
  75: [0.775, 0.165], // amber / orange
  158: [0.72, 0.155], // clean green
  190: [0.705, 0.135], // teal
  265: [0.62, 0.2], // indigo / blue
  292: [0.605, 0.215], // violet
  350: [0.675, 0.185], // pink / magenta
}

/** The grok body fill for a hue — the brighter ramp, gamut-clamped by `oklchHex`. */
export function grokBodyColor(hue: number): string {
  const [L, C] = GROK_TRIM[hue] ?? [0.7, 0.16]
  return oklchHex(L, C, hue)
}

/** A single centred circular face solid every grok blob seats its eyes on, so the
 *  eyes are always well-placed and consistent no matter the silhouette. */
const GROK_FACE = { rx: 114, ry: 114, rz: 114, n: 2 } as const

/**
 * Return a grok-flavoured copy of `ch`: same identity (seed · silhouette · hue),
 * cleaner pigment, and eyes calmed to read as a confident, forward-facing,
 * matched pair. The blob outline is unaffected — `grokSilhouettePath` keys only
 * on `silhouette`+`seed`, both preserved — so this changes the FACE, not the body.
 */
export function grokTune(ch: Character): Character {
  return {
    ...ch,
    color: grokBodyColor(ch.hue),
    // One consistent, centred face for every blob's eyes.
    body: { ...GROK_FACE },
    faceDY: 0,
    // Centre the resting gaze — a whisper of drift stays for life, not a side-eye.
    gaze: Math.round(ch.gaze * 0.3),
    eyes: {
      ...ch.eyes,
      // Calm the idle tilt toward Grok's near-vertical capsules.
      angleL: ch.eyes.angleL * 0.5,
      angleR: ch.eyes.angleR * 0.5,
    },
    // Halve the per-eye asymmetry: a matched pair with a little life.
    asym: {
      w: 1 + (ch.asym.w - 1) * 0.5,
      h: 1 + (ch.asym.h - 1) * 0.5,
      py: ch.asym.py * 0.5,
      slant: ch.asym.slant * 0.5,
    },
    // Face forward — barely-there head pose so the eyes meet yours.
    pose: {
      ...ch.pose,
      x: ch.pose.x * 0.3,
      y: ch.pose.y * 0.3,
      z: ch.pose.z * 0.3,
    },
  }
}
