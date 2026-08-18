/**
 * The Grok-skin blob silhouette — an organic pebble outline, one static path.
 * ─────────────────────────────────────────────────────────────────────────────
 * Under the Grok skin ([data-grok]) a session's body is drawn as a soft,
 * lopsided blob instead of the projected superellipsoid the base app ships. The
 * recipe is ADAPTED (not depended-on) from Alain00/blobatar (MIT) and the
 * georgedoescode blob tutorial — see NOTICE at the repo root:
 *
 *   N radial vertices at equal angles → each radius = a per-archetype base
 *   profile × a per-seed jitter (±~14%) → the loop is closed with the SAME
 *   Catmull-Rom→cubic-Bézier spline the base bodies use (`geometry.ts`
 *   `smoothClosed`), so it interpolates every vertex exactly and emits ONE
 *   static `<path>`. No noise function, no superformula, no per-frame path math
 *   — all "life" is CSS transform on this fixed path (repo-eval decision).
 *
 * IDENTITY IS PRESERVED. The base app's 63 identity tokens are `silhouette × hue`
 * (`assignRoster`). Here the blob's ARCHETYPE is chosen by the same silhouette
 * index, so a session that dedupes to (pebble, hue 265) wears a pebble-shaped
 * blob in hue 265 under either skin — the shape *language* changes, the identity
 * channel does not. The per-seed jitter is what makes two sessions sharing an
 * archetype still read as two different pebbles.
 *
 * PURE + DOM-free, like its siblings. Entry-safe: this module is only reached
 * through `geometry.ts` → `session-mark.tsx` (the lazy marks chunk), never
 * through the entry-reachable `grok-agent-hue.ts` path.
 */
import { hash32, SILHOUETTES, type Character, type SilhouetteName } from './character'

type Pt = [number, number]

/** A blob archetype: vertex count, base ellipse, and a small radial profile that
 *  gives the 9 silhouette slots visibly different personalities at 18–44px. */
interface Arche {
  /** Radial vertices — more = lumpier. */
  n: number
  /** Base half-extents (the blob's ellipse before profiling + jitter). */
  rx: number
  ry: number
  /**
   * `k` lobes of `amp` amplitude, phase `ph` (radians): `1 + amp·cos(k·θ+ph)`.
   * This is what turns a plain ellipse into an egg, a wedge-y triangle, a
   * diamond, a boxy square — without ever leaving the one-static-path recipe.
   */
  k: number
  amp: number
  ph: number
  /** Per-seed jitter amount (fraction of radius). */
  jit: number
}

/**
 * One archetype per silhouette slot, indexed exactly like `SILHOUETTES`
 * (sphere · egg · capsule · blob · cube · pebble · cloud · wedge · rhombus).
 * Tuned so the nine read apart: round, tall-egg, tall-capsule, lumpy-wide,
 * boxy, wide-flat, bumpy-cloud, triangle-ish, diamond-ish.
 */
const ARCHES: Readonly<Record<SilhouetteName, Arche>> = {
  sphere: { n: 8, rx: 116, ry: 116, k: 0, amp: 0, ph: 0, jit: 0.05 },
  egg: { n: 8, rx: 104, ry: 122, k: 1, amp: 0.06, ph: Math.PI / 2, jit: 0.06 },
  capsule: { n: 9, rx: 94, ry: 126, k: 2, amp: 0.05, ph: 0, jit: 0.05 },
  blob: { n: 9, rx: 122, ry: 108, k: 3, amp: 0.09, ph: 0.7, jit: 0.11 },
  cube: { n: 8, rx: 112, ry: 112, k: 4, amp: 0.11, ph: Math.PI / 4, jit: 0.05 },
  pebble: { n: 9, rx: 124, ry: 100, k: 2, amp: 0.08, ph: 0.4, jit: 0.09 },
  cloud: { n: 11, rx: 116, ry: 104, k: 5, amp: 0.1, ph: 0.2, jit: 0.13 },
  wedge: { n: 9, rx: 116, ry: 112, k: 3, amp: 0.16, ph: -Math.PI / 2, jit: 0.06 },
  rhombus: { n: 8, rx: 114, ry: 114, k: 4, amp: 0.2, ph: 0, jit: 0.05 },
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
 * `smoothClosed` so the outline shares the base bodies' pillowy spline.
 */
export function grokBlobPoints(ch: Character): Pt[] {
  const arche = ARCHES[ch.silhouette] ?? ARCHES.sphere
  const rand = jitterStream(ch.seed)
  const { n, rx, ry, k, amp, ph, jit } = arche
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * TAU - Math.PI / 2
    // Base profile: an ellipse modulated by k lobes → the archetype personality.
    const profile = 1 + amp * Math.cos(k * theta + ph)
    // Per-vertex seed jitter → the lopsided-pebble asymmetry (blobatar's nugget).
    const j = 1 + rand() * jit
    const r = profile * j
    pts.push([Math.cos(theta) * rx * r, Math.sin(theta) * ry * r])
  }
  return pts
}

/** Test/debug seam: the archetype table is indexed by the silhouette wheel. */
export const GROK_BLOB_ARCHETYPES = SILHOUETTES.map((s) => ARCHES[s])
