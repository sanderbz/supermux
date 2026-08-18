/**
 * `lib/grok-agent-hue.ts` — the Grok-mode per-agent hue write.
 *
 * The engine's hue derivation is unit-tested elsewhere (`marks-character`,
 * `roster-marks`); what is tested HERE is the contract this module adds on top:
 *   · it writes exactly the five `--sm-agent-*` properties and NOTHING else — no
 *     tone variable ever leaks in (the identity/status firewall, tokens.md §6);
 *   · it is a pure function of the IMMUTABLE slug, so a rename cannot recolour a
 *     room, and two different slugs are free to differ;
 *   · the body tier (tint/coat/bubble) is theme-independent; the accent tier is
 *     theme-dependent (darkened on light, lifted on dark);
 *   · a deduped roster pin overrides the hash-pure hue, so the shell wears the
 *     same slot the on-screen mark does;
 *   · "no session focused" writes an empty object, not a colour.
 */
import { describe, expect, test } from 'bun:test'

import { accentInk, bodyColor, characterFromSeed, HUE_SLOTS } from '../../src/brand/marks'
import {
  AGENT_HUE_VARS,
  agentHueVars,
  agentHueVarsFor,
  agentHueVarsForSeed,
} from '../../src/lib/grok-agent-hue'

describe('agentHueVars', () => {
  test('writes exactly the five --sm-agent-* properties', () => {
    const vars = agentHueVars(HUE_SLOTS[0], false)
    expect(Object.keys(vars).sort()).toEqual([...AGENT_HUE_VARS].sort())
    expect(AGENT_HUE_VARS).toHaveLength(5)
  })

  test('every written property is a --sm-agent-* name — no tone/status leak', () => {
    const vars = agentHueVars(HUE_SLOTS[3], true)
    for (const key of Object.keys(vars)) {
      expect(key.startsWith('--sm-agent-')).toBe(true)
      expect(key).not.toContain('tone')
      expect(key).not.toContain('status')
    }
  })

  test('body tier (tint/coat/bubble) is the flat mark fill and theme-independent', () => {
    const hue = HUE_SLOTS[2]
    const light = agentHueVars(hue, false) as Record<string, string>
    const dark = agentHueVars(hue, true) as Record<string, string>
    const body = bodyColor(hue)
    for (const v of ['--sm-agent-tint', '--sm-agent-coat', '--sm-agent-bubble']) {
      expect(light[v]).toBe(body)
      expect(dark[v]).toBe(body) // same on both papers
    }
  })

  test('accent tier is accentInk and DOES swap with theme; ink is white', () => {
    const hue = HUE_SLOTS[4]
    const light = agentHueVars(hue, false) as Record<string, string>
    const dark = agentHueVars(hue, true) as Record<string, string>
    expect(light['--sm-agent-accent']).toBe(accentInk(hue, false))
    expect(dark['--sm-agent-accent']).toBe(accentInk(hue, true))
    expect(light['--sm-agent-accent']).not.toBe(dark['--sm-agent-accent'])
    expect(light['--sm-agent-ink']).toBe('#fff')
    expect(dark['--sm-agent-ink']).toBe('#fff')
  })
})

describe('agentHueVarsForSeed', () => {
  test('derived from the slug — identical for the same slug (rename-stable)', () => {
    // The function only ever sees the slug; a display-name rename never reaches
    // it, so the same slug is byte-identical no matter what the row is labelled.
    expect(agentHueVarsForSeed('release-train', false)).toEqual(
      agentHueVarsForSeed('release-train', false),
    )
  })

  test('a deduped roster pin overrides the hash-pure hue', () => {
    const seed = 'patch'
    const pinnedHue = HUE_SLOTS[(HUE_SLOTS.indexOf(characterFromSeed(seed).hue) + 3) % HUE_SLOTS.length]
    expect(agentHueVarsForSeed(seed, false, { hue: pinnedHue })).toEqual(
      agentHueVars(pinnedHue, false),
    )
  })

  test('distinct slugs are free to differ (identity is per-slug)', () => {
    // Not every pair differs (7 hues, collisions exist), but the map is not a
    // constant: at least one slug must land on a different hue than another.
    const seeds = ['compass', 'lookout', 'quill', 'ledger', 'kestrel', 'release-train']
    const hues = new Set(seeds.map((s) => characterFromSeed(s).hue))
    expect(hues.size).toBeGreaterThan(1)
  })
})

describe('agentHueVarsFor', () => {
  test('no session focused writes an empty object (not a colour)', () => {
    expect(agentHueVarsFor(null, false)).toEqual({})
    expect(agentHueVarsFor(undefined, true)).toEqual({})
    expect(agentHueVarsFor({ name: '' }, false)).toEqual({})
  })

  test('a focused session writes the five properties for its slug', () => {
    const vars = agentHueVarsFor({ name: 'release-train' }, true) as Record<string, string>
    expect(Object.keys(vars).sort()).toEqual([...AGENT_HUE_VARS].sort())
    expect(vars).toEqual(agentHueVarsForSeed('release-train', true) as Record<string, string>)
  })
})
