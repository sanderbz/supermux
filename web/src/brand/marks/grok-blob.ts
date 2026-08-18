/**
 * The Grok-skin blob silhouette — a soft, organically-round pebble, one path.
 * ─────────────────────────────────────────────────────────────────────────────
 * Under the Grok skin ([data-grok]) a session's body is a cute rounded blob
 * instead of the projected superellipsoid the base app ships. The recipe is a
 * FAITHFUL port of Alain00/blobatar's `blobPath` (MIT — see NOTICE at the repo
 * root) and the georgedoescode blob tutorial:
 *
 *   N radial vertices at equal angles → each radius = a per-archetype base
 *   profile × a per-seed jitter → the ring is closed with a Catmull-Rom spline
 *   converted to cubic Béziers, run over those N vertices DIRECTLY (no
 *   densification). Catmull-Rom interpolates every vertex exactly and
 *   auto-derives a smooth tangent there, so the outline is genuinely round —
 *   ONE static `<path>` of `C` commands, never a straight-line polygon.
 *
 * WHY IT WAS ANGULAR BEFORE, AND WHY IT ISN'T NOW. The previous engine ran the
 * ~8 vertices through `densify(4)` before the spline, which inserts many
 * collinear points along the straight chords between vertices; Catmull-Rom
 * through collinear points is a straight line, so every "curve" flattened and
 * the corners kept only a hair of rounding — the gem/wedge/rhombus look. It also
 * leaned on high-amplitude `cos(k·θ)` lobes sampled at a vertex count that
 * aliased them into hard diamonds. Both are gone: the spline sees the raw
 * vertices, the amplitudes are gentle, and the vertex counts are chosen so no
 * lobe aliases. Every archetype is now a soft rounded creature — silhouette
 * variety lives in the ASPECT ratio + a whisper of low-harmonic personality, not
 * in sharp geometry.
 *
 * IDENTITY IS PRESERVED. The base app's 63 identity tokens are `silhouette × hue`
 * (`assignRoster`). Here the blob's ARCHETYPE is chosen by the same silhouette
 * index, so a session that dedupes to (pebble, hue 265) wears a pebble-shaped
 * blob in hue 265 under either skin — the shape *language* changes, the identity
 * channel does not. The per-seed jitter makes two sessions sharing an archetype
 * still read as two different pebbles.
 *
 * PURE + DOM-free, like its siblings. Reached only through `geometry.ts` →
 * `session-mark.tsx` (the lazy marks chunk), never the entry-reachable path.
 */
import { hash32, SILHOUETTES, type Character, type SilhouetteName } from './character'

type Pt = [number, number]

/** One low-frequency radial harmonic: `amp · cos(k·θ + phase)`. Amplitudes are
 *  deliberately gentle — a personality bias on a round base, never a spike. */
interface Harmonic {
  k: number
  amp: number
  ph: number
}

/**
 * A blob archetype. The base ellipse (`rx`,`ry`) carries the gross silhouette
 * identity (round · tall · wide · …); the harmonics add a soft directional or
 * bumpy personality; `jit` is the per-seed lopsidedness. `n` (vertex count) is
 * chosen coprime-ish with every harmonic `k` so nothing aliases into a polygon.
 */
interface Arche {
  n: number
  rx: number
  ry: number
  /** Up to two gentle harmonics (the second omitted for pure/round shapes). */
  h: readonly Harmonic[]
  jit: number
}

// Handy phases. A `+sin(θ)` bias (k=1, ph=−π/2) bulges the BOTTOM and narrows
// the top → egg / pear / gumdrop. A `−cos(2θ)` term (k=2, ph=π) bulges top AND
// bottom while pinching the sides → a soft vertical leaf / lozenge.
const BOTTOM = -Math.PI / 2

/**
 * One archetype per silhouette slot, indexed exactly like `SILHOUETTES`
 * (sphere · egg · capsule · blob · cube · pebble · cloud · wedge · rhombus).
 * ALL SMOOTH, ALL ROUNDED — the three that used to be gems (cube · wedge ·
 * rhombus) are now a chunky rounded square, a cute gumdrop, and a soft leaf.
 */
const ARCHES: Readonly<Record<SilhouetteName, Arche>> = {
  // pure round pebble — the calm baseline.
  sphere: { n: 10, rx: 116, ry: 116, h: [], jit: 0.05 },
  // upright egg: taller than wide, bottom a touch rounder than the top.
  egg: { n: 12, rx: 104, ry: 121, h: [{ k: 1, amp: 0.05, ph: BOTTOM }], jit: 0.05 },
  // tall soft pill — the spline of a narrow tall ellipse.
  capsule: { n: 12, rx: 95, ry: 126, h: [], jit: 0.045 },
  // wide organic lump — the archetypal "blob", carried mostly by jitter.
  blob: { n: 11, rx: 122, ry: 106, h: [{ k: 2, amp: 0.06, ph: 0.6 }], jit: 0.1 },
  // chunky rounded square — a whisper of 4 soft corners, never a diamond.
  cube: { n: 14, rx: 115, ry: 112, h: [{ k: 4, amp: 0.05, ph: Math.PI / 4 }], jit: 0.05 },
  // wide-flat lopsided pebble.
  pebble: { n: 12, rx: 124, ry: 100, h: [{ k: 1, amp: 0.06, ph: 0.4 }], jit: 0.09 },
  // gently bumpy cloud — five soft lobes, sampled so they never sharpen.
  cloud: { n: 14, rx: 116, ry: 104, h: [{ k: 5, amp: 0.06, ph: 0.2 }], jit: 0.07 },
  // cute gumdrop / pear — heavier bottom, softly narrowed top.
  wedge: { n: 12, rx: 110, ry: 114, h: [{ k: 1, amp: 0.13, ph: BOTTOM }], jit: 0.05 },
  // soft vertical leaf / lozenge — rounded points top & bottom, gentle waist.
  rhombus: { n: 12, rx: 100, ry: 119, h: [{ k: 2, amp: 0.1, ph: Math.PI }], jit: 0.04 },
}

const TAU = Math.PI * 2

/** A small seeded [-1,1] wobble stream, warmed like `character.ts`'s rng. */
function jitterStream(seed: string): () => number {
  let s = hash32(seed + '#blob') || 1
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return (s / 4294967296) * 2 - 1
  }
  for (let i = 0; i < 6; i++) next()
  return next
}

/**
 * The blob's radial vertices for a character, in authored coordinates (the same
 * ±131 viewBox as every body). Deterministic: archetype from the silhouette
 * slot, jitter from the seed. Returned as points; the caller runs them through
 * `smoothClosed` DIRECTLY (no densify) so the outline is a true round spline.
 */
export function grokBlobPoints(ch: Character): Pt[] {
  const arche = ARCHES[ch.silhouette] ?? ARCHES.sphere
  const rand = jitterStream(ch.seed)
  const { n, rx, ry, h, jit } = arche
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * TAU - Math.PI / 2
    // Base profile: 1 + the gentle harmonics → the archetype's personality.
    let profile = 1
    for (const { k, amp, ph } of h) profile += amp * Math.cos(k * theta + ph)
    // Per-vertex seed jitter → the lopsided-pebble asymmetry (blobatar's nugget).
    const r = profile * (1 + rand() * jit)
    pts.push([Math.cos(theta) * rx * r, Math.sin(theta) * ry * r])
  }
  return pts
}

/** Test/debug seam: the archetype table is indexed by the silhouette wheel. */
export const GROK_BLOB_ARCHETYPES = SILHOUETTES.map((s) => ARCHES[s])
