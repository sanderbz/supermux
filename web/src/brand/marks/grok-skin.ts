/**
 * Is the Grok skin active? — the one signal the mark needs in JS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Almost everything the skin changes about a face is CSS under `[data-grok]`
 * (negative-space eyes, the glow, every motion). The ONE thing that cannot be a
 * CSS override is the body OUTLINE: under the skin the silhouette is an organic
 * blob (`grok-blob.ts`), a different `<path d>`, so `<SessionMark>` must know the
 * skin at render time.
 *
 * It reads the DOM, not a store: the shell root stamps `data-grok` once at mount
 * (`layout.tsx`, a reload-level decision), and every mark lives inside it. We
 * LATCH on first detection and never un-latch — the skin never flips live, and
 * the marks chunk is lazy (it mounts well after the shell has committed its
 * attribute), so by the time any mark renders the attribute is present.
 *
 * No `document` (SSR, `bun test`'s node runner) ⇒ `false` ⇒ the base face, which
 * is exactly what the engine's unit tests assert. Callers may override with an
 * explicit `grok` prop (the `/dev/marks` bench renders both skins on one page).
 *
 * Relative-import clean on purpose: `session-mark.tsx` is resolved directly by
 * the unit runner, which does not read the app's `@/…` path aliases — so this
 * sibling touches nothing but the global `document`.
 */
let latched = false

export function grokSkinActive(): boolean {
  if (latched) return true
  if (typeof document === 'undefined') return false
  if (document.querySelector('[data-grok]')) {
    latched = true
    return true
  }
  return false
}

/** Test seam: forget the latch so a suite can assert both skins in one process. */
export function __resetGrokSkinLatch(): void {
  latched = false
}
