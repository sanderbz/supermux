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

// Handy phase. A `+sin(θ)` bias (k=1, ph=−π/2) bulges the BOTTOM and narrows
// the top → egg / drop / gumdrop. k=1 is the ONLY family-wide personality lever
// (plus one gentle k=4 squircle): it just DISPLACES the centre of mass, so the
// outline stays convex for any amplitude — it can never grow a point the way the
// old k=2/k=4-rotated/k=5 lobes did (those pinched the sides or the diagonals
// into the gem/leaf/spike the jury rated 2/10). Variety now lives in the ASPECT
// ratio + per-seed jitter, exactly like blobatar's own generator.
const BOTTOM = -Math.PI / 2

/**
 * One archetype per silhouette slot, indexed exactly like `SILHOUETTES`. The
 * SLOT NAMES stay (they are the identity channel `assignRoster` deduplicates and
 * the base app's frozen tokens), but every SHAPE is now an organic convex
 * super-ellipse — the round mascot family the jury asked for. The comment on each
 * row is the shape it actually draws:
 *
 *   sphere→circle · egg→egg · capsule→pill · blob→blob · cube→squircle ·
 *   pebble→pebble · cloud→cloud · wedge→drop · rhombus→bean
 *
 * NO gem, NO diamond, NO triangle, NO 4-fold pointed symmetry anywhere. The three
 * that used to be angular (cube · wedge · rhombus) are a soft rounded squircle, a
 * plump teardrop, and a lopsided bean — all convex, all round at 18px. Every
 * shape's silhouette is carried by its aspect ratio and a whisper of k=1 lean,
 * never by a sharp harmonic; `n` (vertex count) stays coprime-ish with every `k`
 * so nothing aliases into a polygon.
 */
const ARCHES: Readonly<Record<SilhouetteName, Arche>> = {
  // circle — the pure round pebble, the calm baseline.
  sphere: { n: 12, rx: 116, ry: 116, h: [], jit: 0.05 },
  // egg — upright, taller than wide, bottom a touch rounder than the top.
  egg: { n: 12, rx: 106, ry: 121, h: [{ k: 1, amp: 0.06, ph: BOTTOM }], jit: 0.05 },
  // pill — a tall soft capsule (narrow tall ellipse, splined round).
  capsule: { n: 12, rx: 95, ry: 126, h: [], jit: 0.045 },
  // blob — a wide organic lump, personality carried mostly by jitter + gentle lean.
  blob: { n: 11, rx: 122, ry: 107, h: [{ k: 1, amp: 0.05, ph: 0.7 }], jit: 0.11 },
  // squircle — a plump rounded square: a whisper of 4 CARDINAL bulges (ph 0, not
  // π/4), so the flats face up/down/left/right and it reads as a soft square, the
  // exact opposite of the old ph=π/4 diamond.
  cube: { n: 16, rx: 114, ry: 112, h: [{ k: 4, amp: 0.038, ph: 0 }], jit: 0.05 },
  // pebble — wide, flat, lopsided.
  pebble: { n: 12, rx: 124, ry: 100, h: [{ k: 1, amp: 0.06, ph: 0.4 }], jit: 0.09 },
  // cloud — a soft, generously-jittered wide blob (the old spiky 5-lobe cloud is
  // gone; a cloud reads as a round pillowy lump here, not a scalloped edge).
  cloud: { n: 13, rx: 118, ry: 106, h: [{ k: 1, amp: 0.05, ph: 2.1 }], jit: 0.1 },
  // drop — a plump teardrop / gumdrop: heavier bottom, softly domed top. Convex,
  // never the pointed triangle the old amp-0.13 wedge produced.
  wedge: { n: 12, rx: 108, ry: 116, h: [{ k: 1, amp: 0.085, ph: BOTTOM }], jit: 0.05 },
  // bean — a lopsided round pebble leaning on one diagonal. NO waist pinch, so it
  // can never read as the vertical leaf / diamond the old k=2 rhombus did.
  rhombus: { n: 12, rx: 114, ry: 108, h: [{ k: 1, amp: 0.07, ph: 0.9 }], jit: 0.06 },
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
 * The archetype's radial ring, in authored coordinates (the same ±131 viewBox as
 * every body). `jitter` supplies the per-vertex [-1,1] wobble: a seeded stream
 * for the per-session grok blob, or a constant 0 for the canonical, shared base
 * silhouette. Returned as points; the caller runs them through `smoothClosed`
 * DIRECTLY (no densify) so the outline is a true round spline.
 */
function blobRing(arche: Arche, jitter: () => number): Pt[] {
  const { n, rx, ry, h, jit } = arche
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * TAU - Math.PI / 2
    // Base profile: 1 + the gentle harmonics → the archetype's personality.
    let profile = 1
    for (const { k, amp, ph } of h) profile += amp * Math.cos(k * theta + ph)
    // Per-vertex jitter → the lopsided-pebble asymmetry (blobatar's nugget).
    const r = profile * (1 + jitter() * jit)
    pts.push([Math.cos(theta) * rx * r, Math.sin(theta) * ry * r])
  }
  return pts
}

/**
 * The Grok blob's radial vertices for a character. Deterministic: archetype from
 * the silhouette slot, per-vertex jitter from the seed — so two sessions sharing
 * an archetype still read as two different pebbles.
 */
export function grokBlobPoints(ch: Character): Pt[] {
  const arche = ARCHES[ch.silhouette] ?? ARCHES.sphere
  return blobRing(arche, jitterStream(ch.seed))
}

/**
 * The BASE silhouette's radial vertices for an authored slot — the canonical,
 * seed-INDEPENDENT version of the same organic archetype (jitter forced to 0).
 *
 * This is what makes the ROUND blob the shipped default: `geometry.ts` draws the
 * three authored slots (cloud · wedge · rhombus) from this ring instead of the
 * old angular rounded-polygon (the diamond / triangle the jury rated 2/10), so
 * default users — every skin, every size — see a smooth convex creature, never a
 * gem. The grok skin then layers its per-seed jitter, hue, glow and expression on
 * top of an already-round base. Seed-independent by design: an authored outline
 * is a shared drawing (two sessions on `cloud` get the identical body; the eyes
 * and pigment carry their difference), which the mark unit tests pin.
 */
export function baseBlobPoints(silhouette: SilhouetteName): Pt[] {
  const arche = ARCHES[silhouette] ?? ARCHES.sphere
  return blobRing(arche, () => 0)
}

/** Test/debug seam: the archetype table is indexed by the silhouette wheel. */
export const GROK_BLOB_ARCHETYPES = SILHOUETTES.map((s) => ARCHES[s])
