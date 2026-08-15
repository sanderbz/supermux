/**
 * <SessionMark> — the DOM contract of a face.
 *
 * Rendered with `react-dom/server` (the repo's unit runner has no DOM), which is
 * exactly the surface that matters here: what the component paints *before* any
 * animation frame runs is the still frame, and the still frame is what a
 * reduced-motion user, a screenshot, and a server render all keep forever.
 *
 * The three contracts under test:
 *   · the silhouette never moves between states (concept contract C5 falsifier:
 *     any body-path delta outside the eyes fails);
 *   · state is carried by the eyes, and only by the eyes;
 *   · `prefers-reduced-motion` renders the same face, static — no `data-live`,
 *     no per-seed animation phase, eyes fully open.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { characterFromSeed, eyesFor } from '../../src/brand/marks/character'
import { eyePath, poseQuat } from '../../src/brand/marks/geometry'
import { SessionMark } from '../../src/brand/marks/session-mark'

/**
 * The component reads `window.matchMedia` at render time. Bun's unit runner has
 * no DOM at all, which the component treats as "no motion" — so a stub is how we
 * exercise the animated branch.
 */
function withMotionPreference<T>(reduce: boolean, fn: () => T): T {
  const prev = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: () => ({
      matches: reduce,
      addEventListener() {},
      removeEventListener() {},
    }),
  }
  try {
    return fn()
  } finally {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = prev
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

/** The `d` of every path in a rendered mark, in document order: body, eyeL, eyeR. */
function paths(markup: string): string[] {
  return [...markup.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
}

describe('the silhouette never moves', () => {
  test('the body path is byte-identical across every state', () => {
    const bodies = (['idle', 'working', 'waiting', 'done', 'stopped', 'failed'] as const).map(
      (state) => paths(renderToStaticMarkup(<SessionMark seed="Quill" state={state} />))[0],
    )
    expect(new Set(bodies).size).toBe(1)
  })

  test('two sessions on the same solid still get different bodies', () => {
    // Solids are projected from per-seed jittered radii and a per-seed pose, so
    // no two sphere-people are the same sphere. (Authored outlines — cloud,
    // wedge, rhombus — are drawn, not projected, and are deliberately shared;
    // there the pigment and the eyes carry the difference.) This is also the
    // guard on the body memo: a key collision would return a stranger's face.
    const seeds = ['Release Train', 'Patch', 'Quill', 'Ledger', 'Compass', 'Lookout', 'Kestrel']
    const solids = seeds.filter((s) => !characterFromSeed(s).authored)
    expect(solids.length).toBeGreaterThan(1)
    const bodies = solids.map((seed) => paths(renderToStaticMarkup(<SessionMark seed={seed} />))[0])
    expect(new Set(bodies).size).toBe(solids.length)
  })

  test('the same authored outline is shared, by design', () => {
    const a = paths(
      renderToStaticMarkup(<SessionMark seed="Lookout" pin={{ silhouette: 'cloud' }} />),
    )[0]
    const b = paths(
      renderToStaticMarkup(<SessionMark seed="Kestrel" pin={{ silhouette: 'cloud' }} />),
    )[0]
    expect(a).toBe(b)
  })

  test('the body path is byte-identical across sizes — geometry is unitless', () => {
    const a = paths(renderToStaticMarkup(<SessionMark seed="Quill" size={18} />))[0]
    const b = paths(renderToStaticMarkup(<SessionMark seed="Quill" size={40} />))[0]
    expect(a).toBe(b)
  })
})

describe('state lives in the eyes', () => {
  test('each state paints different eyes — in the STILL frame', () => {
    // The still frame is what reduced motion, a screenshot and a server render
    // all keep forever, so every state must be separable with zero animation.
    // (`stopped` used to render byte-identical to `idle` and was told apart only
    // by not blinking — invisible to a reduced-motion user.)
    const states = ['idle', 'working', 'waiting', 'done', 'stopped', 'failed'] as const
    const eyes = states.map((state) =>
      withMotionPreference(true, () =>
        paths(renderToStaticMarkup(<SessionMark seed="Quill" state={state} />)).slice(1).join('|'),
      ),
    )
    expect(new Set(eyes).size).toBe(states.length)
  })

  test('the painted eyes are exactly the engine geometry at blink = 1', () => {
    const ch = characterFromSeed('Release Train')
    const q = poseQuat(ch)
    const e = eyesFor(ch, 'working')
    const [, l, r] = paths(
      renderToStaticMarkup(<SessionMark seed="Release Train" state="working" />),
    )
    expect(l).toBe(eyePath(ch, q, e, -1, 1))
    expect(r).toBe(eyePath(ch, q, e, 1, 1))
  })

  test('the eyes are white on every body', () => {
    for (const seed of ['Release Train', 'Patch', 'Quill', 'Lookout']) {
      const markup = renderToStaticMarkup(<SessionMark seed={seed} />)
      const fills = [...markup.matchAll(/fill="([^"]+)"/g)].map((m) => m[1])
      expect(fills.slice(1)).toEqual(['#ffffff', '#ffffff'])
      expect(fills[0]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('motion', () => {
  test('reduced motion renders the still frame — no data-live, no phase', () => {
    const markup = withMotionPreference(true, () =>
      renderToStaticMarkup(<SessionMark seed="Quill" state="working" />),
    )
    expect(markup).not.toContain('data-live')
    expect(markup).not.toContain('animation-delay')
  })

  test('reduced motion paints the same face as the animated first frame', () => {
    const still = withMotionPreference(true, () =>
      renderToStaticMarkup(<SessionMark seed="Quill" state="waiting" />),
    )
    const livePaint = withMotionPreference(false, () =>
      renderToStaticMarkup(<SessionMark seed="Quill" state="waiting" />),
    )
    expect(paths(still)).toEqual(paths(livePaint))
  })

  test('a live state animates, with a per-seed breathe phase', () => {
    const markup = withMotionPreference(false, () =>
      renderToStaticMarkup(<SessionMark seed="Quill" state="working" />),
    )
    expect(markup).toContain('data-live="1"')
    const delay = markup.match(/animation-delay:\s*(-?[\d.]+)s/)
    expect(delay).not.toBeNull()
    expect(Number(delay![1])).toBeCloseTo(-characterFromSeed('Quill').clock, 2)
  })

  test('done, stopped and failed never animate, even with motion allowed', () => {
    for (const state of ['done', 'stopped', 'failed'] as const) {
      const markup = withMotionPreference(false, () =>
        renderToStaticMarkup(<SessionMark seed="Quill" state={state} />),
      )
      expect(markup).not.toContain('data-live')
    }
  })

  test('animate={false} opts a mark out entirely (dense strips, previews)', () => {
    const markup = withMotionPreference(false, () =>
      renderToStaticMarkup(<SessionMark seed="Quill" state="working" animate={false} />),
    )
    expect(markup).not.toContain('data-live')
  })
})

describe('DOM contract', () => {
  test('size drives the box, not the geometry', () => {
    const markup = renderToStaticMarkup(<SessionMark seed="Quill" size={18} />)
    expect(markup).toContain('width="18"')
    expect(markup).toContain('height="18"')
    expect(markup).toContain('viewBox="-131 -131 262 262"')
  })

  test('identity and state are exposed as data attributes', () => {
    const markup = renderToStaticMarkup(
      <SessionMark seed="Quill" state="waiting" pin={{ silhouette: 'cloud', hue: 292 }} />,
    )
    expect(markup).toContain('data-shape="cloud"')
    expect(markup).toContain('data-hue="292"')
    expect(markup).toContain('data-state="waiting"')
  })

  test('the mark is labelled by default and mutable to silence', () => {
    const named = renderToStaticMarkup(<SessionMark seed="Release Train" />)
    expect(named).toContain('role="img"')
    expect(named).toContain('aria-label="Release Train"')

    const silent = renderToStaticMarkup(<SessionMark seed="Release Train" label={null} />)
    expect(silent).toContain('aria-hidden="true"')
    expect(silent).not.toContain('role="img"')
    expect(silent).not.toContain('aria-label')
  })

  test('a ring is stroked under the fill at a size-independent 2px', () => {
    const markup = renderToStaticMarkup(<SessionMark seed="Quill" size={18} ring="#faf7f4" />)
    expect(markup).toContain('stroke="#faf7f4"')
    expect(markup).toContain('paint-order="stroke"')
    // 2 CSS px at 18px box = 2 · 262 / 18 ≈ 29.1 viewBox units.
    expect(markup).toContain('stroke-width="29.1"')
  })

  test('className is merged, never replaced', () => {
    const markup = renderToStaticMarkup(<SessionMark seed="Quill" className="absolute" />)
    expect(markup).toContain('sm-mark')
    expect(markup).toContain('absolute')
  })
})
