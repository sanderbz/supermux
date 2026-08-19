/**
 * `lib/mark-status.ts` — the status → face table, and the two-channel guard.
 *
 * B0 shipped six eye geometries and proved they are separable in a still frame,
 * but never the sentence that connects them to the product. Without a single
 * table every surface invents its own mapping and the mark stops being a status
 * channel — so the table is total by construction, and the SOURCE SCAN below is
 * the structural half: the three roster surfaces must not import `StatusDot`
 * directly, or the app quietly grows two status channels again.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import {
  attentionFor,
  MARK_STATE_FOR,
  markStateFor,
  markStateForSession,
} from '../../src/lib/mark-status'

const SRC = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')

/** The TS union, verbatim — parsed rather than re-typed so the test fails when
 *  the union grows a member and nobody decides what its face does. */
const STATUSES = (() => {
  const src = SRC('lib/api/sessions.ts')
  const block = src.slice(
    src.indexOf('export type SessionStatus'),
    src.indexOf('export type SessionMode'),
  )
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
})()

describe('the mapping is total', () => {
  test('the union was parsed at all (guards a dead test)', () => {
    expect(STATUSES.length).toBeGreaterThan(3)
    expect(STATUSES).toContain('starting')
    expect(STATUSES).toContain('error')
  })

  test('every SessionStatus has a face', () => {
    for (const s of STATUSES) {
      expect(Object.keys(MARK_STATE_FOR)).toContain(s)
      expect(markStateFor(s)).toBeTruthy()
    }
  })

  test('the table has no members the union does not', () => {
    expect(Object.keys(MARK_STATE_FOR).sort()).toEqual([...STATUSES].sort())
  })

  test('the two judgement calls are named explicitly', () => {
    // `starting` is the boot window — busy, not asleep. The DOT renders it
    // neutral grey because a dot cannot say "busy but not yet productive".
    expect(markStateFor('starting')).toBe('working')
    // `error` is `failed`, NEVER `stopped`: "fell over" and "asleep" are the two
    // states a user must not confuse, which is why B0 drew them separately.
    expect(markStateFor('error')).toBe('failed')
    expect(markStateFor('stopped')).toBe('stopped')
  })

  test('an unknown status renders a calm face rather than nothing', () => {
    // The wire is JSON: a future server can hand us a status this build never
    // heard of. A row with no face is broken; "calm" is the safest lie.
    expect(markStateFor('teleporting')).toBe('idle')
    expect(markStateFor(undefined)).toBe('idle')
    expect(markStateFor('')).toBe('idle')
  })

  test('Rust and TS disagree, and the mapping is written against TS', () => {
    // server/src/sessions/status.rs has Unknown and NO Error; the TS union has
    // `error` and no `unknown`. Errors ride the separate `error:{type,message}`
    // delta key, which is why the `needs` tier reads the FIELD, not a status.
    expect(STATUSES).not.toContain('unknown')
    expect(SRC('lib/mark-status.ts')).toContain('status.rs')
  })
})

describe('one status channel, not two', () => {
  const ROSTER_SURFACES = [
    'components/session-tile/tile.tsx',
    'components/session-tile/session-row.tsx',
    'components/focus-mode/compact-tile.tsx',
  ]

  test('no roster surface imports StatusDot directly', () => {
    for (const rel of ROSTER_SURFACES) {
      const src = SRC(rel)
      const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*status-dot'/g)]
      const named = imports.flatMap((m) => m[1].split(',').map((x) => x.trim()))
      expect(named).not.toContain('StatusDot')
    }
  })

  test('they all draw the face through the one component that owns the switch', () => {
    for (const rel of ROSTER_SURFACES) {
      expect(SRC(rel)).toContain('SessionFace')
    }
  })

  test('SessionFace is the only place the kill switch is read', () => {
    const face = SRC('components/roster/session-face.tsx')
    expect(face).toContain('isRosterMarksEnabled')
    expect(face).toContain('StatusDot')
  })

  test('STATUS_LABEL is still shared — the label is not the dot', () => {
    // Deleting `status-dot.tsx` would take the label map with it; the surfaces
    // legitimately keep importing THAT.
    expect(SRC('components/session-tile/session-row.tsx')).toContain('STATUS_LABEL')
  })
})

describe('the Grok-skin resolver: markStateForSession + attentionFor', () => {
  test('live hints outrank the status word, most-specific first', () => {
    // done > streaming > thinking, then the status fallback.
    expect(markStateForSession({ status: 'active' }, { done: true })).toBe('done')
    expect(markStateForSession({ status: 'active' }, { streaming: true })).toBe('streaming')
    expect(markStateForSession({ status: 'idle' }, { thinking: true })).toBe('thinking')
    expect(markStateForSession({ status: 'active' }, { done: true, streaming: true })).toBe('done')
  })

  test('starting resolves to the honest connecting scan, not a faked working', () => {
    // The base table stays `starting → working` (byte-identical); the Grok skin
    // refines it on the FACE to `connecting` (coming online, not yet productive).
    expect(markStateFor('starting')).toBe('working')
    expect(markStateForSession({ status: 'starting' })).toBe('connecting')
  })

  test('with no hints it agrees with the base table on every plain status', () => {
    for (const s of ['active', 'idle', 'waiting', 'stopped', 'error'] as const) {
      expect(markStateForSession({ status: s })).toBe(markStateFor(s))
    }
  })

  test('attentionFor reads the FIELDS, not the status word (the decoupling)', () => {
    expect(attentionFor({ status: 'waiting' })).toBe('needs')
    expect(attentionFor({ status: 'idle', error: { type: 'x', message: 'y' } })).toBe('blocked')
    expect(attentionFor({ status: 'active', permission_request: {} })).toBe('blocked')
    expect(attentionFor({ status: 'active', elicitation: {} })).toBe('blocked')
    expect(attentionFor({ status: 'active' })).toBe(null)
    // blocked outranks needs — an open dialog is louder than a finished turn.
    expect(attentionFor({ status: 'waiting', error: { type: 'x', message: 'y' } })).toBe('blocked')
  })
})
