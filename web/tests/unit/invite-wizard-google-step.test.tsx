/**
 * The invite wizard's Google step must SAY what happened.
 * ─────────────────────────────────────────────────────────────────────────────
 * Witnessed live: an owner pasted a Client ID + Secret on step 2 and pressed
 * "Save & verify". The button read "Verifying…" for about a tenth of a second,
 * reverted, and nothing else moved — no error, no advance, the rail chip still
 * saying "Not set up". The server had in fact taken BOTH calls: Google was
 * `configured` and `POST /verify-login` had answered
 * `{ok:true, detail:"Ready — colleagues can sign in at …"}`.
 *
 * The step's whole view was derived from the status query, and the click handler
 * only ever nudged it with a fire-and-forget `refetch()` — so a landed save was
 * invisible until a second round-trip happened to arrive, and a THROWN verify was
 * swallowed by `catch {}` (`verify.isError` was rendered nowhere). Both silences
 * are pinned here:
 *
 *  · `runGoogleVerify` — a `{ok:true}` verify hands its sentence straight to
 *    `onVerified` (chip → done, stepper → the next step). No refetch in the path.
 *  · `googleOutcome` — a thrown save or verify becomes a rendered error, and a
 *    refused `{ok:false}` keeps its detail plus "Check again" (existing behaviour,
 *    locked so the rewrite cannot lose it).
 *  · The rendered surfaces carry the text, with `role="status"` / `role="alert"`.
 *
 * This suite has no DOM (no happy-dom, no testing-library), so the orchestration
 * is asserted as the exported function the button calls, and the surfaces via
 * `renderToStaticMarkup` — the same posture as `connect-grant-human-gated`.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { GoogleOutcomeLine, GoogleReadyCard } from '../../src/components/companies/invite-wizard-sheet'
import {
  ORDER,
  googleOutcome,
  googleStepDone,
  runGoogleVerify,
  showCheckAgain,
  stepAfter,
} from '../../src/lib/invite-wizard'
import { SessionError } from '../../src/lib/api'
import type { ExternalStatus, VerifyLoginResult } from '../../src/lib/api'

const READY = 'Ready — colleagues can sign in at https://reisposter-ai.iwd.nl.'

const verified = (over: Partial<VerifyLoginResult> = {}): VerifyLoginResult => ({
  ok: true,
  detail: READY,
  redirect_uri: 'https://reisposter-ai.iwd.nl/auth/callback',
  ...over,
})

/** The status the browser was still holding when the save had already landed. */
const staleStatus = (): ExternalStatus =>
  ({
    box_status: { tunnel: 'healthy', google: 'none', base_domain: 'iwd.nl' },
    company: { host: 'reisposter-ai.iwd.nl', redirect_registered: 'unknown' },
  }) as unknown as ExternalStatus

describe('a successful save + verify moves the step by itself', () => {
  test('an {ok:true} verify hands its sentence up — no refetch needed first', async () => {
    const seen: string[] = []
    let advancedWith: string | null = null
    let refetched = 0
    await runGoogleVerify({
      save: async () => {
        seen.push('save')
      },
      verify: async () => {
        seen.push('verify')
        return verified()
      },
      refetch: () => {
        refetched += 1
      },
      onVerified: (d) => {
        advancedWith = d
      },
    })
    // Save first, then verify — and the advance is driven by verify's own answer.
    expect(seen).toEqual(['save', 'verify'])
    expect(advancedWith).toBe(READY)
    // The background re-read still happens; it is just no longer load-bearing.
    expect(refetched).toBe(1)
  })

  test('the sentence the server said is what the step shows', () => {
    const out = googleOutcome({ verifyResult: verified() })
    expect(out).toEqual({ kind: 'ready', text: READY })
    const html = renderToStaticMarkup(<GoogleOutcomeLine outcome={out} />)
    expect(html).toContain('data-vr="google-ready"')
    expect(html).toContain('Google login verified')
    expect(html).toContain('sign in at https://reisposter-ai.iwd.nl.')
    expect(html).toContain('role="status"')
  })

  test('the chip flips done on the local verification even while status is stale', () => {
    // Exactly the live case: the server was configured, the browser was not told.
    expect(googleStepDone(staleStatus(), null)).toBe(false)
    expect(googleStepDone(staleStatus(), READY)).toBe(true)
    expect(googleStepDone(undefined, READY)).toBe(true)
  })

  test('the step it advances to is the next one in the real order', () => {
    expect(stepAfter(ORDER, 'google')).toBe('person')
    expect(stepAfter(ORDER, 'success')).toBeNull()
  })

  test('the confirmation card carries the detail verbatim', () => {
    const html = renderToStaticMarkup(<GoogleReadyCard detail={READY} />)
    expect(html).toContain(READY)
  })
})

describe('a thrown verify is rendered, never swallowed', () => {
  test('the throw stops the advance, keeps the re-read, and does not escape', async () => {
    let advanced = 0
    let refetched = 0
    await runGoogleVerify({
      save: async () => {},
      verify: async () => {
        throw new SessionError('verify-login failed (500)', 500)
      },
      refetch: () => {
        refetched += 1
      },
      onVerified: () => {
        advanced += 1
      },
    })
    expect(advanced).toBe(0)
    expect(refetched).toBe(1)
  })

  test('a thrown verify becomes an alert with the server’s words', () => {
    const out = googleOutcome({ verifyError: new SessionError('verify-login failed (500)', 500) })
    expect(out.kind).toBe('error')
    expect(out.text).toBe('verify-login failed (500)')
    expect(showCheckAgain(out)).toBe(true)
    const html = renderToStaticMarkup(<GoogleOutcomeLine outcome={out} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('verify-login failed (500)')
  })

  test('an offline verify says the reachable thing, not "nothing happened"', () => {
    const out = googleOutcome({ verifyError: new SessionError('fetch failed', 0) })
    expect(out.kind).toBe('error')
    expect(out.text).toContain('Can’t reach supermux-server')
  })

  test('a failed save short-circuits: verify is never called', async () => {
    let verifies = 0
    let advanced = 0
    await runGoogleVerify({
      save: async () => {
        throw new SessionError('client_secret is required', 400)
      },
      verify: async () => {
        verifies += 1
        return verified()
      },
      refetch: () => {},
      onVerified: () => {
        advanced += 1
      },
    })
    expect(verifies).toBe(0)
    expect(advanced).toBe(0)
    expect(googleOutcome({ saveError: new SessionError('client_secret is required', 400) })).toEqual(
      { kind: 'error', text: 'client_secret is required' },
    )
  })
})

describe('a refused verify keeps its existing behaviour', () => {
  test('{ok:false} renders the detail and offers Check again — and never advances', async () => {
    let advanced = 0
    const refused = verified({ ok: false, detail: 'redirect_uri_mismatch — add https://x/auth/callback' })
    await runGoogleVerify({
      save: async () => {},
      verify: async () => refused,
      refetch: () => {},
      onVerified: () => {
        advanced += 1
      },
    })
    expect(advanced).toBe(0)

    const out = googleOutcome({ verifyResult: refused })
    expect(out).toEqual({ kind: 'failed', text: refused.detail })
    expect(showCheckAgain(out)).toBe(true)
    const html = renderToStaticMarkup(<GoogleOutcomeLine outcome={out} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('redirect_uri_mismatch')
  })

  test('nothing attempted yet says nothing at all', () => {
    const out = googleOutcome({})
    expect(out.kind).toBe('idle')
    expect(showCheckAgain(out)).toBe(false)
    expect(renderToStaticMarkup(<GoogleOutcomeLine outcome={out} />)).toBe('')
  })

  test('a live error outranks a stale success — the newest truth wins', () => {
    const out = googleOutcome({
      verifyError: new SessionError('verify-login failed (500)', 500),
      verifiedDetail: READY,
    })
    expect(out.kind).toBe('error')
  })
})
