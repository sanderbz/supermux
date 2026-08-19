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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * The MOUTH FIREWALL — the base app must stay byte-identical.
 * ─────────────────────────────────────────────────────────────────────────────
 * `<SessionMark>` emits `.sm-mark__mouth` on the three states that wear one
 * (streaming / done / failed) REGARDLESS of skin — it is a filled SVG path, not
 * a CSS decoration, so it cannot gate itself on `[data-grok]` the way the glow
 * and the halo do. The gate is therefore CSS, and it is a two-rule pair:
 *
 *   globals.css    `.sm-mark__mouth { display: none }`            (base: hidden)
 *   grok-mode.css  `[data-grok] .sm-mark__mouth { display: block }` (grok: shown)
 *
 * Delete or weaken either half and a base-app `done` mark grows a smile and a
 * base-app `failed` mark grows a frown — the exact regression this file exists
 * to catch. The pair is load-bearing on THREE properties, all asserted below:
 * the base rule is unprefixed, the reveal out-specifies it (0,1,0 vs 0,2,0),
 * and neither rule sits inside an `@layer` (a layered reveal would lose to the
 * unlayered hide no matter how specific it is).
 */
describe('the mouth is firewalled behind [data-grok]', () => {
  const SRC = fileURLToPath(new URL('../../src', import.meta.url))
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  const GLOBALS = strip(readFileSync(join(SRC, 'styles/globals.css'), 'utf8'))
  const GROK = strip(readFileSync(join(SRC, 'styles/grok-mode.css'), 'utf8'))

  const MOUTH_STATES = ['streaming', 'done', 'failed'] as const
  const MOUTHLESS_STATES = ['idle', 'connecting', 'thinking', 'working', 'waiting', 'stopped'] as const

  test('the component paints a mouth on exactly streaming / done / failed', () => {
    for (const state of MOUTH_STATES) {
      const markup = renderToStaticMarkup(<SessionMark seed="Quill" state={state} />)
      expect(markup).toContain('sm-mark__mouth')
    }
    for (const state of MOUTHLESS_STATES) {
      const markup = renderToStaticMarkup(<SessionMark seed="Quill" state={state} />)
      expect(markup).not.toContain('sm-mark__mouth')
    }
  })

  test('the mouth is emitted off-grok too — which is WHY the CSS gate must exist', () => {
    // No `grok` prop is threaded to any call site; the markup is skin-blind.
    // This test is the premise of the two that follow, not a defect.
    const markup = renderToStaticMarkup(<SessionMark seed="Quill" state="done" />)
    expect(markup).toContain('class="sm-mark__mouth"')
  })

  test('globals.css hides `.sm-mark__mouth` with an UNPREFIXED base rule', () => {
    const rule = /(^|\})\s*\.sm-mark__mouth\s*\{([^}]*)\}/m.exec(GLOBALS)
    expect(rule).not.toBeNull()
    expect(rule![2]).toContain('display: none')
  })

  test('grok-mode.css reveals it, and the reveal out-specifies the hide', () => {
    const rule = /\[data-grok\]\s+\.sm-mark__mouth\s*\{([^}]*)\}/.exec(GROK)
    expect(rule).not.toBeNull()
    // `display: block` (or `revert`) — anything that is not `none`.
    expect(/display:\s*(?!none)[a-z-]+/.test(rule![1])).toBe(true)
    // Specificity: (0,2,0) attribute+class beats the base (0,1,0) class.
    // Both rules are plain descendant selectors, so this is decidable by shape.
  })

  test('neither half sits inside an `@layer` — a layered reveal would lose', () => {
    // Unlayered declarations beat EVERY layered one regardless of specificity,
    // so if the hide is unlayered the reveal must be unlayered as well.
    const insideLayer = (css: string, needle: string) => {
      const at = css.indexOf(needle)
      expect(at).toBeGreaterThan(-1)
      let depth = 0
      let layerDepth = -1
      for (let i = 0; i < at; i++) {
        if (css.startsWith('@layer', i) && css.indexOf('{', i) > -1 && layerDepth < 0) layerDepth = depth
        if (css[i] === '{') depth++
        else if (css[i] === '}') {
          depth--
          if (layerDepth >= 0 && depth <= layerDepth) layerDepth = -1
        }
      }
      return depth > 0
    }
    expect(insideLayer(GLOBALS, '.sm-mark__mouth')).toBe(false)
    expect(insideLayer(GROK, '[data-grok] .sm-mark__mouth')).toBe(false)
  })

  test('the grok-only motion still hangs off the revealed mouth', () => {
    // display:none would also kill these; they must stay under [data-grok].
    expect(GROK).toContain("[data-grok] .sm-mark[data-state='streaming'] .sm-mark__mouth")
    expect(GROK).toContain("[data-grok] .sm-mark[data-state='done'] .sm-mark__mouth")
    expect(GROK).toContain('sm-stream-mouth')
    expect(GROK).toContain('sm-mouth-pop')
  })
})
