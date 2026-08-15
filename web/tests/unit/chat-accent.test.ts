/**
 * Per-session accent — the mechanism `board-patch-focused.png` proves.
 * ─────────────────────────────────────────────────────────────────────────────
 * That board is `board-light.png` re-shot with Patch focused: roster wash,
 * composer focus ring and the selected choice all changed, and nothing else
 * did. This file pins the three properties that make that true and keep it
 * true:
 *
 *   1. the accent is a PURE function of the session's immutable slug (a rename
 *      must not change a session's colour, and the mark beside every message is
 *      derived from the same seed),
 *   2. it is written ONCE, on the chat surface root — not on `:root` (the shell
 *      would wear a session's colour) and not scattered down the tree,
 *   3. it never touches a status affordance (concept contract C7): status lives
 *      in the `--status-*` family so that "which session" and "how is it going"
 *      stay two channels a user can read independently.
 *
 * No JSX here on purpose — the deliverable is a `.ts` module test and
 * `React.createElement` keeps it one.
 */
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { bodyColor, characterFromSeed } from '../../src/brand/marks'
import { ChatSurface, SurfaceStatus } from '../../src/components/chat/chat-surface'
import {
  SESSION_ACCENT_VARS,
  sessionAccentVars,
  sessionAccentVarsFor,
} from '../../src/components/chat/session-accent'
import type { TileSession } from '../../src/components/session-tile/types'

/** Two members of the approved cast whose hues differ (teal vs violet). */
const TEAL = 'release-train'
const VIOLET = 'patch'

function session(over: Partial<TileSession> & { name: string }): TileSession {
  return {
    status: 'idle',
    dir: '/opt/projects/supermux',
    provider: 'claude',
    preview_lines: [],
    updated_at: '2026-08-14T10:00:00Z',
    ...over,
  }
}

const html = renderToStaticMarkup
const accent = (vars: Record<string, unknown>) => vars['--sm-accent']

describe('sessionAccentVars', () => {
  test('two sessions, two accents', () => {
    const a = sessionAccentVars(TEAL) as Record<string, string>
    const b = sessionAccentVars(VIOLET) as Record<string, string>
    expect(accent(a)).not.toBe(accent(b))
  })

  test('one session, one accent — stable across calls', () => {
    expect(sessionAccentVars(TEAL)).toEqual(sessionAccentVars(TEAL))
  })

  test('both names are written, from one derivation', () => {
    // B0 shipped `--sm-accent`; the master plan §11.3 calls the shell variable
    // `--sm-session-tint`. They must be the same colour by construction, or
    // "the session's colour" would mean two different things in one tree.
    const vars = sessionAccentVars(TEAL) as Record<string, string>
    expect(Object.keys(vars).sort()).toEqual([...SESSION_ACCENT_VARS].sort())
    expect(vars['--sm-session-tint']).toBe(vars['--sm-accent'])
  })

  test('the colour is the mark’s own body fill — one pigment per session', () => {
    const vars = sessionAccentVars(TEAL) as Record<string, string>
    expect(vars['--sm-accent']).toBe(bodyColor(characterFromSeed(TEAL).hue))
  })

  test('a pin fixes the hue, the way a roster assignment does', () => {
    const pinned = sessionAccentVars(TEAL, { hue: characterFromSeed(VIOLET).hue })
    expect(accent(pinned as Record<string, string>)).toBe(
      accent(sessionAccentVars(VIOLET) as Record<string, string>),
    )
  })
})

describe('sessionAccentVarsFor', () => {
  test('seeds from the slug — a rename does not change a face', () => {
    const renamed = session({ name: VIOLET, display_name: 'Release Train' })
    expect(sessionAccentVarsFor(renamed)).toEqual(sessionAccentVars(VIOLET))
    // …and the display name does not participate at all: two sessions labelled
    // the same, with different slugs, are still two different colours.
    const other = session({ name: TEAL, display_name: 'Release Train' })
    expect(accent(sessionAccentVarsFor(other) as Record<string, string>)).not.toBe(
      accent(sessionAccentVarsFor(renamed) as Record<string, string>),
    )
  })

  test('no session writes nothing — the shell keeps the brand fallback', () => {
    // An empty object is a value here: it is the difference between "nothing is
    // focused" (`:root`'s amber) and "a session whose colour happens to be amber".
    expect(sessionAccentVarsFor(null)).toEqual({})
    expect(sessionAccentVarsFor(undefined)).toEqual({})
  })
})

describe('C7 — where the accent may and may not appear', () => {
  const errored = session({ name: TEAL, status: 'error' })
  const surface = () =>
    html(createElement(ChatSurface, { name: TEAL, session: errored }))

  test('written exactly once, on the surface root', () => {
    const out = surface()
    const rootTag = out.slice(0, out.indexOf('>') + 1)
    expect(rootTag).toContain('--sm-accent:')
    expect(rootTag).toContain('--sm-session-tint:')
    // Everything below the root inherits it; nothing below the root re-declares
    // it. A second write is how a subtree silently stops following the session.
    const rest = out.slice(rootTag.length)
    expect(rest).not.toContain('--sm-accent')
    expect(rest).not.toContain('--sm-session-tint')
  })

  test('the status affordance is in the status family, never the accent', () => {
    const badge = html(createElement(SurfaceStatus, { session: errored }))
    expect(badge).toContain('status-error')
    expect(badge).not.toContain('--sm-accent')
    expect(badge).not.toContain('--sm-session-tint')
    // And the surface renders that same badge — the guard is on shipped markup,
    // not on a component nobody mounts.
    expect(surface()).toContain('data-testid="chat-surface-status"')
  })

  test('the two families never share a name', () => {
    for (const v of SESSION_ACCENT_VARS) expect(v.startsWith('--status')).toBe(false)
  })
})
