// Fase A5 T1 — the renderer preference decision table.
//
// Pure `bun test`: no DOM, no React, no store. Everything the rest of the fase
// reads goes through these functions, so this file is the net for "an
// ineligible session can never render chat" and "auto is never stored".

import { describe, expect, test } from 'bun:test'

import {
  EMPTY_RENDERER_STATE as EMPTY,
  MAX_PINS,
  capPins,
  parseRendererPrefs,
  parseRendererPrefsOrNull,
  prefFor,
  prune,
  resolveRenderer,
  serializeRendererPrefs,
  setPref,
  togglePref,
  type RendererState,
} from '../../src/components/chat/renderer-pref'

describe('resolveRenderer', () => {
  test('ineligible session resolves to terminal even when pinned to chat', () => {
    const st = setPref(EMPTY, 'codex-1', 'chat')
    expect(resolveRenderer(st, 'codex-1', /* chatOn */ false, true)).toBe('terminal')
    // The pin SURVIVES — flipping the Settings toggle back on restores it.
    expect(prefFor(st, 'codex-1')).toBe('chat')
  })

  test('unknown session resolves to null (no doomed-terminal flash)', () => {
    expect(resolveRenderer(EMPTY, 'x', true, false)).toBeNull()
  })

  test('undecided beats eligibility — an ineligible unresolved row is still null', () => {
    expect(resolveRenderer(EMPTY, 'x', false, false)).toBeNull()
  })

  test('auto follows the global default, both ways', () => {
    expect(
      resolveRenderer({ defaultRenderer: 'terminal', overrides: {} }, 'a', true, true),
    ).toBe('terminal')
    expect(
      resolveRenderer({ defaultRenderer: 'chat', overrides: {} }, 'a', true, true),
    ).toBe('chat')
  })

  test('a pin beats the default for its own session only', () => {
    const st = setPref({ defaultRenderer: 'chat', overrides: {} }, 'a', 'terminal')
    expect(resolveRenderer(st, 'a', true, true)).toBe('terminal')
    expect(resolveRenderer(st, 'b', true, true)).toBe('chat')
  })
})

describe('setPref / prefFor', () => {
  test('setting auto REMOVES the key rather than storing "auto"', () => {
    const st = setPref(setPref(EMPTY, 'a', 'chat'), 'a', 'auto')
    expect(Object.keys(st.overrides)).toEqual([])
    expect(prefFor(st, 'a')).toBe('auto')
    // And it never appears in the persisted blob.
    expect(serializeRendererPrefs(st)).not.toContain('auto')
  })

  test('an unpinned session reads back as auto', () => {
    expect(prefFor(EMPTY, 'nobody')).toBe('auto')
  })

  test('a no-op write returns the SAME object (no store churn / no PUT storm)', () => {
    const st = setPref(EMPTY, 'a', 'chat')
    expect(setPref(st, 'a', 'chat')).toBe(st)
    expect(setPref(EMPTY, 'a', 'auto')).toBe(EMPTY)
  })
})

describe('togglePref', () => {
  test('toggles between the two CONCRETE renderers, never to auto', () => {
    expect(togglePref('chat')).toBe('terminal')
    expect(togglePref('terminal')).toBe('chat')
  })
})

describe('prune', () => {
  test('drops dead sessions and keeps live ones', () => {
    let st: RendererState = EMPTY
    st = setPref(st, 'alive', 'terminal')
    st = setPref(st, 'dead', 'chat')
    const next = prune(st, ['alive', 'other'])
    expect(Object.keys(next.overrides)).toEqual(['alive'])
  })

  test('a STOPPED-but-present session keeps its pin (never run on a filtered list)', () => {
    const st = setPref(EMPTY, 'stopped-1', 'chat')
    // The caller passes the FULL list — a hidden/stopped row is still in it.
    expect(prune(st, ['stopped-1']).overrides['stopped-1']).toBe('chat')
  })

  test('caps at MAX_PINS, keeping the most recently pinned', () => {
    let st: RendererState = EMPTY
    const names: string[] = []
    for (let i = 0; i < MAX_PINS + 20; i++) {
      names.push(`s${i}`)
      st = setPref(st, `s${i}`, 'chat')
    }
    const next = prune(st, names)
    const keys = Object.keys(next.overrides)
    expect(keys.length).toBe(MAX_PINS)
    expect(keys[keys.length - 1]).toBe(`s${MAX_PINS + 19}`)
    expect(keys[0]).toBe('s20')
  })

  test('returns the SAME object when nothing changes', () => {
    const st = setPref(EMPTY, 'a', 'chat')
    expect(prune(st, ['a'])).toBe(st)
  })
})

describe('capPins', () => {
  test('caps without any liveness information (the rehydrate path)', () => {
    let st: RendererState = EMPTY
    for (let i = 0; i < MAX_PINS + 5; i++) st = setPref(st, `s${i}`, 'terminal')
    expect(Object.keys(capPins(st).overrides).length).toBe(MAX_PINS)
  })

  test('an empty list cannot delete every pin (capPins is not prune)', () => {
    const st = setPref(EMPTY, 'a', 'chat')
    expect(capPins(st).overrides['a']).toBe('chat')
  })
})

describe('parse / serialize', () => {
  test('round-trips', () => {
    const st = setPref({ defaultRenderer: 'terminal', overrides: {} }, 'a', 'chat')
    expect(parseRendererPrefs(serializeRendererPrefs(st))).toEqual(st)
  })

  test('404-as-unset and garbage both degrade to the default, never throw', () => {
    expect(parseRendererPrefs(null)).toEqual(EMPTY)
    expect(parseRendererPrefs('')).toEqual(EMPTY)
    expect(parseRendererPrefs('not json')).toEqual(EMPTY)
    expect(parseRendererPrefs('[]')).toEqual(EMPTY)
    expect(parseRendererPrefs('"str"')).toEqual(EMPTY)
  })

  test('UNSET is distinguishable from empty (or the sync wipes local pins)', () => {
    // A fresh account 404s on this key. Reading that as "an empty preference"
    // would let the sync apply it over whatever localStorage already held.
    expect(parseRendererPrefsOrNull(null)).toBeNull()
    expect(parseRendererPrefsOrNull('')).toBeNull()
    expect(parseRendererPrefsOrNull('{}')).toEqual(EMPTY)
    expect(parseRendererPrefsOrNull(serializeRendererPrefs(EMPTY))).toEqual(EMPTY)
  })

  test('unknown values are dropped, not adopted', () => {
    const st = parseRendererPrefs(
      JSON.stringify({
        defaultRenderer: 'auto',
        overrides: { a: 'auto', b: 'chat', c: 42 },
      }),
    )
    // `auto` is not a mountable renderer — the global default falls back.
    expect(st.defaultRenderer).toBe('chat')
    expect(st.overrides).toEqual({ b: 'chat' })
  })
})
