/**
 * LEGACY ROW SAFETY — a session whose provider supermux no longer ships.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Kimi Code provider was removed. Its ROWS were not: the production DB
 * holds at least one `provider: 'kimi'` session, and `provider` is a free-form
 * string on the wire, so the app meets it on every list. The rule this file
 * pins is the whole safety story on the client:
 *
 *   · the row still RENDERS — it is not dropped from a list, and nothing in the
 *     render path treats an unknown provider as a fatal case;
 *   · it is INERT — no Start button, no Resume, no "make it a team". The server
 *     answers `POST /start` with a 400, and an affordance that can only produce
 *     an error is worse than no affordance at all;
 *   · it SAYS SO — one honest note naming the retirement, so the missing Start
 *     reads as a decision rather than a bug;
 *   · Archive SURVIVES — the one thing a retired row can still do is leave.
 *
 * The counter-case (a normal Claude row is untouched) is asserted in the same
 * file: a guard that hides the Start button for everybody would pass every
 * assertion above and be a catastrophe.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import {
  isRetiredProvider,
  retiredProviderLabel,
  retiredProviderNote,
} from '../../src/lib/retired-providers'
import { StoppedSessionActions } from '../../src/components/terminal/stopped-session'
import { ToastProvider } from '../../src/components/ui/toast'
import { SESSIONS_KEY } from '../../src/hooks/use-sessions'
import type { ApiSession } from '../../src/lib/api'

const row = (provider: string): ApiSession =>
  ({
    name: 'legacy-kimi',
    dir: '/opt/projects/legacy',
    provider,
    status: 'stopped',
    preview_lines: [],
    updated_at: new Date().toISOString(),
  }) as unknown as ApiSession

/** Render the shared action cluster with the sessions list PRE-SEEDED, which is
 *  how the component sees a row (it reads `useSessions`, never a prop). */
const actions = (provider: string): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(SESSIONS_KEY, [row(provider)])
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <StoppedSessionActions name="legacy-kimi" showMakeTeam />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

describe('the retired-provider registry', () => {
  test('the retired provider is recognised, live ones are not', () => {
    expect(isRetiredProvider('kimi')).toBe(true)
    expect(isRetiredProvider('claude')).toBe(false)
    expect(isRetiredProvider('codex')).toBe(false)
    expect(isRetiredProvider('shell')).toBe(false)
  })

  test('a missing or unknown provider is not treated as retired', () => {
    // Absent (an older row), empty, or a provider from a NEWER server than this
    // bundle. None of those is a retirement, and guessing would hide a working
    // session's Start button.
    expect(isRetiredProvider(undefined)).toBe(false)
    expect(isRetiredProvider(null)).toBe(false)
    expect(isRetiredProvider('')).toBe(false)
    expect(isRetiredProvider('some-future-agent')).toBe(false)
  })

  test('the note names the provider and stays honest about what is left', () => {
    const note = retiredProviderNote('kimi')
    expect(retiredProviderLabel('kimi')).toBe('Kimi Code')
    expect(note).toContain('Kimi Code')
    expect(note.toLowerCase()).toContain('retired')
    // It must not promise a restart, in any tense.
    expect(note.toLowerCase()).not.toContain('start it again')
  })
})

describe('a retired row renders inert', () => {
  test('no Start button, and the note explains why', () => {
    const out = actions('kimi')
    expect(out).not.toContain('Start session')
    expect(out).toContain('Kimi Code')
    expect(out).toContain('retired')
    expect(out).toContain('data-retired-provider="kimi"')
  })

  test('Archive still works — leaving is the one action that survives', () => {
    expect(actions('kimi')).toContain('Archive')
  })

  test('Resume and Make team are gone too (both would relaunch)', () => {
    const out = actions('kimi')
    expect(out).not.toContain('Resume')
    expect(out).not.toContain('Make team')
  })
})

describe('a supported row is untouched', () => {
  test('a Claude row keeps its Start button and shows no retirement note', () => {
    const out = actions('claude')
    expect(out).toContain('Start session')
    expect(out).not.toContain('retired')
    expect(out).not.toContain('data-retired-provider')
  })

  test('a Codex row keeps Start as well', () => {
    expect(actions('codex')).toContain('Start session')
  })
})
